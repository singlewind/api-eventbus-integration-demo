import { Stack, StackProps, Construct, Tags } from '@aws-cdk/core';

/**
 * The core properties for stacks within the BaseStack stack
 */
export interface BaseStackProps extends StackProps {
  /**
   * The environment name
   */
  environment: string;
  /**
   * The application
   */
  application: string;

  businessFunction: string;

  deploymentJob: string;

  deployment: string;

  createdBy: string;

  service: string;

  version: string;
}

/**
 * Default tags for all observability stacks
 */
export class BaseStack extends Stack {
  constructor(scope: Construct, id: string, props: BaseStackProps) {
    super(scope, id, props);

    //Tagging
    Tags.of(this).add('Environment', `${props.environment}`);
    Tags.of(this).add('Application', `${props.application}`);
    Tags.of(this).add('Service', `${props.service}`);
    Tags.of(this).add('Version', `${props.version}`);
    Tags.of(this).add('DeploymentJob', `${props.deploymentJob}`);
    Tags.of(this).add('Deployment', `${props.deployment}`);
    Tags.of(this).add('BusinessFunction', `${props.businessFunction}`);
    Tags.of(this).add('CreatedBy', `${props.createdBy}`);
  }
}