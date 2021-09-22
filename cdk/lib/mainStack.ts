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
  rateLimit: number;
}

export class MainStack extends BaseStack {
  constructor(scope: cdk.Construct, stackName: string, props: MainStackProps) {
    super(scope, stackName, props)

    // UserPool, 
    const userPool = new cognito.UserPool(this, 'userpool', {
      userPoolName: stackName,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // for demo only
    })

    const domain = new cognito.UserPoolDomain(this, 'userpool-domain', {
      userPool,
      cognitoDomain: {
        domainPrefix: stackName,
      }
    })

    const tokenEndpoint = `https://${domain.domainName}.auth.${this.region}.amazoncognito.com/oauth2/token`

    const identifier = 'user'
    const scopeName = 'secured'
    // App Client
    const resourceServer = new cognito.UserPoolResourceServer(this, 'resource-server', {
      identifier,
      userPool,
      userPoolResourceServerName: props.stackName,
      scopes: [
        new cognito.ResourceServerScope({
          scopeName,
          scopeDescription: 'Secured API',
        })
      ],
    })

    const poolClient = new cognito.UserPoolClient(this, 'client', {
      userPoolClientName: `${stackName}-eventbus-integration`,
      userPool,
      generateSecret: true,
      oAuth: {
        flows: {
          clientCredentials: true,
        },
        scopes: [cognito.OAuthScope.custom(`${identifier}/${scopeName}`)],
      }
    })

    poolClient.node.addDependency(resourceServer)

    // Getting ClientSecret
    // https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_DescribeUserPoolClient.html
    // https://docs.aws.amazon.com/cdk/api/latest/docs/custom-resources-readme.html
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
      // policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
      //   resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE
      // })
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: [
          userPool.userPoolArn
        ]
      })
    })

    const poolClientSecret = describeUserPoolClient.getResponseField(
      'UserPoolClient.ClientSecret'
    )
  
    const clientSecretParameter = new ssm.StringParameter(this, 'client-secret-parameter', {
      parameterName: `${stackName}-app-client-secret`,
      stringValue: poolClientSecret,
    })

    // API
    const api = new apiw.HttpApi(this, 'api', {
      apiName: stackName,
      corsPreflight: {
        allowCredentials: false,
        allowOrigins: ['*'],
        allowHeaders: ['*'],
        allowMethods: [apiw.CorsHttpMethod.POST],
        exposeHeaders: ['*'],
      },
      createDefaultStage: true,
    })

    const defaultStage = api.defaultStage?.node.defaultChild as apiw.CfnStage

    const loggingLogGroup = new logs.LogGroup(this, 'logging-loggroup', {
      logGroupName: `${stackName}-logging`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.ONE_DAY,
    })

    // Below is 2 way to enable access logging
    // Option 1: Generic overrides cloudformation template
    defaultStage.addPropertyOverride('AutoDeploy', true)
    defaultStage.addPropertyOverride('Description', 'Default stage')
    defaultStage.addPropertyOverride('AccessLogSettings', {
      'DestinationArn': loggingLogGroup.logGroupArn,
      'Format': JSON.stringify({
        requestId: '$context.requestId',
        userAgent: '$context.identity.userAgent',
        sourceIp: '$context.identity.sourceIp',
        requestTime: '$context.requestTime',
        requestTimeEpoch: '$context.requestTimeEpoch',
        httpMethod: '$context.httpMethod',
        path: '$context.path',
        status: '$context.status',
        protocol: '$context.protocol',
        responseLength: '$context.responseLength',
        domainName: '$context.domainName'
      })
    })

    // Option 2: CDK way to change values
    // defaultStage.autoDeploy = true
    // defaultStage.description = 'Default stage'
    // defaultStage.accessLogSettings = {
    //   destinationArn: loggingLogGroup.logGroupArn,
    //   format: JSON.stringify({
    //     requestId: '$context.requestId',
    //     userAgent: '$context.identity.userAgent',
    //     sourceIp: '$context.identity.sourceIp',
    //     requestTime: '$context.requestTime',
    //     requestTimeEpoch: '$context.requestTimeEpoch',
    //     httpMethod: '$context.httpMethod',
    //     path: '$context.path',
    //     status: '$context.status',
    //     protocol: '$context.protocol',
    //     responseLength: '$context.responseLength',
    //     domainName: '$context.domainName'
    //   })
    // }

    // Integrate to EventBus directly
    const eventBus = new events.EventBus(this, 'events', {
      eventBusName: stackName,
    })

    const integrationRole = new iam.Role(this, 'integration-role', {
      roleName: `${stackName}-api-integration-role`,
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
    })

    integrationRole.addToPolicy(new iam.PolicyStatement({
      sid: 'eventbridge',
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
        'Source': 'external',
        'DetailType': 'api.request',
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
        'Source': 'eventbus.forward',
        'DetailType': 'api.request',
        'Detail': '$request.body.detail',
        'EventBusName': eventBus.eventBusArn,
        'Resources': eventBus.eventBusArn,
      },
    })

    // JWT authorizor
    const authorizer = new apiw.HttpAuthorizer(this, 'jwt-authorizer', {
      httpApi: api,
      type: apiw.HttpAuthorizerType.JWT,
      authorizerName: stackName,
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
      authorizationScopes: [`${identifier}/${scopeName}`],
    })

    const logGroup = new logs.LogGroup(this, 'logs', {
      logGroupName: `${stackName}-events`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.ONE_DAY,
    });

    const deadLetterQueue = new sqs.Queue(this, 'dlq', {
      queueName: `${stackName}-dlq`,
    })

    const logRule = new events.Rule(this, 'log-rule', {
      ruleName: `${stackName}-log-all-events`,
      eventBus,
      eventPattern: {
        source: [
          'external',
          'eventbus.forward'
        ],
      },
      targets: [
        new targets.CloudWatchLogGroup(logGroup, {
          deadLetterQueue,
        })
      ]
    })

    // Forward the request via ApiDestination
    // https://docs.aws.amazon.com/eventbridge/latest/APIReference/API_CreateConnectionOAuthClientRequestParameters.html
    // https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-events-connection.html
    // https://docs.aws.amazon.com/eventbridge/latest/APIReference/API_ConnectionBodyParameter.html
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
                'Value': `${identifier}/${scopeName}`
              }
            ]
          }
        }
      },
    })

    const apiDestination = new events.CfnApiDestination(this, 'api-destination', {
      name: `${props.stackName}-secure-api`,
      connectionArn: connection.attrArn,
      httpMethod: 'POST',
      invocationEndpoint: `${api.apiEndpoint}/authorized`,
      description: 'Calling Secure API',
      invocationRateLimitPerSecond: props.rateLimit, // 1-300
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
      name: `${stackName}-forward`,
      eventPattern: {
        source: [
          'external'
        ],
      },
      targets: [{
        id: `${stackName}-forward-request`,
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