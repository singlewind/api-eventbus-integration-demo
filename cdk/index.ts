#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { fromEnv } from './lib/core/configUtil';
import { MainStack } from './lib/mainStack';

export const configFromEnv = fromEnv({
  environment: 'ENVIRONMENT',
  application: 'APPLICATION',
  version: 'VERSION',
  deploymentJob: 'DEPLOYMENT_JOB',
  deployment: 'DEPLOYMENT',
  businessFunction: 'BUSINESS_FUNCTION',
  createdBy: 'CREATED_BY',
  service: 'SERVICE',
  stage: 'STAGE',
});

// Developers used to use 'dev' as a short name for the development. Try to keep their convenstions
const environmentName = configFromEnv.environment === 'development' ? 'dev' : configFromEnv.environment;

const prefix =
  environmentName !== configFromEnv.stage
    ? `${configFromEnv.stage}-${environmentName}`
    : environmentName;

const commonProps = {
  environment: configFromEnv.environment === 'dev' ? 'development' : configFromEnv.environment,
  application: configFromEnv.application,
  deploymentJob: configFromEnv.deploymentJob,
  businessFunction: configFromEnv.businessFunction,
  createdBy: configFromEnv.createdBy,
  version: configFromEnv.version,
  deployment: configFromEnv.deployment,
  service: configFromEnv.service,
};

const stackName = `${prefix}-${commonProps.service}`;
const apiBasePath = environmentName === configFromEnv.stage ? configFromEnv.service : `${configFromEnv.stage}-${configFromEnv.service}`;

const app = new cdk.App();

const commonTags = {
  'Environment': commonProps.environment,
  'Application': commonProps.application,
  'Service': commonProps.service,
  'Version': commonProps.version,
  'DeploymentJob': commonProps.deploymentJob,
  'Deployment': commonProps.deployment,
  'BusinessFunction': commonProps.businessFunction,
  'CreatedBy': commonProps.createdBy,
}

new MainStack(app, stackName, {
  ...commonProps,
  apiBasePath,
  rateLimit: 300,
});