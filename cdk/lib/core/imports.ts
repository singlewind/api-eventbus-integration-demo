import * as cdk from '@aws-cdk/core';

export interface BaseImportsProps {
}

export class BaseImports extends cdk.Construct {

  constructor(scope: cdk.Construct, id: string, props: BaseImportsProps) {
    super(scope, id);
  }
}