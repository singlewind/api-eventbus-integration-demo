import * as cdk from '@aws-cdk/core'
import * as iam from '@aws-cdk/aws-iam'
import * as sqs from '@aws-cdk/aws-sqs'
import * as events from '@aws-cdk/aws-events'
import * as targets from '@aws-cdk/aws-events-targets'
import * as apiw from '@aws-cdk/aws-apigatewayv2'
import * as logs from '@aws-cdk/aws-logs'
import * as cognito from '@aws-cdk/aws-cognito'
import * as cr from '@aws-cdk/custom-resources'
import * as ssm from '@aws-cdk/aws-ssm'
import { BaseStack, BaseStackProps } from './core/baseStack'

export interface MainStackProps extends BaseStackProps {
  apiBasePath: string;
  deploymentStage: string;
}

export class MainStack extends BaseStack {
  constructor(scope: cdk.Construct, stackName: string, props: MainStackProps) {
    super(scope, stackName, props)

    // UserPool, 
    const userPool = new cognito.UserPool(this, 'userpool', {
      userPoolName: `${props.environment}-platform-eventbus`,
    })

    const domain = new cognito.UserPoolDomain(this, 'userpool-domain', {
      userPool,
      cognitoDomain: {
        domainPrefix: `${props.environment}-gentu-api`,
      }
    })

    const tokenEndpoint = `https://${domain.domainName}.auth.${this.region}.amazoncognito.com/oauth2/token`

    // App Client
    const resourceServer = new cognito.UserPoolResourceServer(this, 'resource-server', {
      identifier: "gentu",
      userPool,
      userPoolResourceServerName: `${props.environment}-gentu`,
      scopes: [
        new cognito.ResourceServerScope({
          scopeName: 'bulksync',
          scopeDescription: 'Bulk sync gentu practice',
        })
      ],
    })

    const poolClient = new cognito.UserPoolClient(this, 'client', {
      userPoolClientName: `${props.environment}-eventbus-integration`,
      userPool,
      generateSecret: true,
      oAuth: {
        flows: {
          clientCredentials: true,
        },
        scopes: [cognito.OAuthScope.custom('gentu/bulksync')],
      }
    })

    poolClient.node.addDependency(resourceServer)

    // Getting ClientSecret
    const sdkCall: cr.AwsSdkCall = {
      region: this.region,
      service: 'CognitoIdentityServiceProvider',
      action: 'describeUserPoolClient',
      parameters: {
        'UserPoolId': userPool.userPoolId,
        'ClientId': poolClient.userPoolClientId,
      },
      physicalResourceId: cr.PhysicalResourceId.of('call-describe-userpool-client')
    }

    const describeUserPoolClient = new cr.AwsCustomResource(this, 'describe-userpool-client', {
      resourceType: 'Custom::DescribeUserPoolClient',
      onCreate: sdkCall,
      onUpdate: sdkCall,
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE
      })
    })

    const poolClientSecret = describeUserPoolClient.getResponseField(
      'UserPoolClient.ClientSecret'
    )
  
    const clientSecretParameter = new ssm.StringParameter(this, 'client-secret-parameter', {
      parameterName: `${props.environment}-app-client-secret`,
      stringValue: poolClientSecret,
    })

    // API
    const api = new apiw.HttpApi(this, 'api', {
      apiName: `${stackName}-api`,
    })

    const stage = new apiw.HttpStage(this, 'stage', {
      httpApi: api,
      stageName: props.deploymentStage,
      autoDeploy: true,
    })

    // Integrate to EventBus directly
    const eventBus = new events.EventBus(this, 'events', {
      eventBusName: stackName,
    })

    const integrationRole = new iam.Role(this, 'integration-role', {
      roleName: `${stackName}-integration-role`,
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
    })

    integrationRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['events:PutEvents'],
      resources: [
        eventBus.eventBusArn,
      ],
    }))

    //https://docs.aws.amazon.com/eventbridge/latest/APIReference/API_PutEvents.html
    //https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-aws-services-reference.html
    const eventbusIntegration = new apiw.CfnIntegration(this, 'eventbus-integration', {
      apiId: api.apiId,
      integrationType: apiw.HttpIntegrationType.LAMBDA_PROXY,
      payloadFormatVersion: '1.0',
      timeoutInMillis: 10_000,
      integrationSubtype: 'EventBridge-PutEvents',
      credentialsArn: integrationRole.roleArn,
      requestParameters: {
        'Source': 'platform.admin.api',
        'DetailType': 'au.com.geniesolutions.bulksync',
        'Detail': '$request.body',
        'EventBusName': eventBus.eventBusArn,
        'Resources': `arn:${this.partition}:apigateway:${this.region}:${this.account}:/apis/${api.apiId}`,
      },
    })

    const eventsRoute = new apiw.CfnRoute(this, 'events-route', {
      
      apiId: api.apiId,
      routeKey: `${apiw.HttpMethod.POST} /events`,
      target: `integrations/${eventbusIntegration.ref}`
    })


    // 2nd endpoint, protected API
    const authorizedIntegration = new apiw.CfnIntegration(this, 'authorized-integration', {
      apiId: api.apiId,
      integrationType: apiw.HttpIntegrationType.LAMBDA_PROXY,
      payloadFormatVersion: '1.0',
      timeoutInMillis: 10_000,
      integrationSubtype: 'EventBridge-PutEvents',
      credentialsArn: integrationRole.roleArn,
      requestParameters: {
        'Source': 'platform.eventbus',
        'DetailType': 'au.com.geniesolutions.bulksync',
        'Detail': '$request.body',
        'EventBusName': eventBus.eventBusArn,
        'Resources': eventBus.eventBusArn,
      },
    })

    // JWT authorizor
    const authorizer = new apiw.HttpAuthorizer(this, 'jwt-authorizer', {
      httpApi: api,
      type: apiw.HttpAuthorizerType.JWT,
      authorizerName: `${props.environment}-platform-admin`,
      identitySource: ['$request.header.Authorization'],
      jwtIssuer: `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      jwtAudience: [poolClient.userPoolClientId],
    })

    const authorizedRoute = new apiw.CfnRoute(this, 'authorized-route', {
      apiId: api.apiId,
      routeKey: `${apiw.HttpMethod.POST} /authorized`,
      target: `integrations/${authorizedIntegration.ref}`,
      authorizationType: 'JWT',
      authorizerId: authorizer.authorizerId,
      authorizationScopes: ['gentu/bulksync'],
    })

    const logGroup = new logs.LogGroup(this, 'logs', {
      logGroupName: `${stackName}-events`,
    });

    const deadLetterQueue = new sqs.Queue(this, 'dlq')

    const logRule = new events.Rule(this, 'log-rule', {
      ruleName: `${props.environment}-log-all-events`,
      eventBus,
      eventPattern: {
        source: [
          'platform.admin.api',
          'platform.eventbus'
        ],
      },
      targets: [
        new targets.CloudWatchLogGroup(logGroup, {
          deadLetterQueue,
        })
      ]
    })


    // Forward the request via ApiDestination
    const connection = new events.CfnConnection(this, 'api-connection', {
      authorizationType: 'OAUTH_CLIENT_CREDENTIALS',
      name: `${props.environment}-gentu-api`,
      description: 'Connection to Gentu API',
      authParameters: {
        'OAuthParameters': {
          'ClientParameters': {
            'ClientID': poolClient.userPoolClientId,
            'ClientSecret': clientSecretParameter.stringValue,
          },
          'HttpMethod': 'POST',
          'AuthorizationEndpoint': tokenEndpoint,
          'OAuthHttpParameters': {
            'BodyParameters': [
              {
                'Key': 'grant_type',
                'Value': 'client_credentials'
              },
              {
                'Key': 'scope',
                'Value': 'gentu/bulksync'
              }
            ]
          }
        }
      },
    })

    const apiDestination = new events.CfnApiDestination(this, 'api-destination', {
      name: `${props.environment}-api-destination`,
      connectionArn: connection.attrArn,
      httpMethod: 'POST',
      invocationEndpoint: `${api.apiEndpoint}/authorized`,
      description: 'Calling Gentu API'
    })

    const forwardRole = new iam.Role(this, 'forward-role', {
      roleName: `${stackName}-api-destination-role`,
      assumedBy: new iam.ServicePrincipal('events.amazonaws.com')
    })

    forwardRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['events:InvokeApiDestination'],
      resources: [
        apiDestination.attrArn,
      ],
    }))

    const forwardRule = new events.CfnRule(this, 'forward-rule', {
      eventBusName: eventBus.eventBusName,
      name: `${props.environment}-bulk-sync`,
      eventPattern: {
        source: [
          'platform.admin.api'
        ],
      },
      targets: [{
        id: `${props.environment}-gentu-api`,
        arn: apiDestination.attrArn,
        roleArn: forwardRole.roleArn,
        deadLetterConfig: {
          arn: deadLetterQueue.queueArn
        }
      }]
    })

    new cdk.CfnOutput(this, 'token-endpoint', {
      value: tokenEndpoint
    })

    new cdk.CfnOutput(this, 'api-endpoint', {
      value: api.apiEndpoint
    })
  }
}