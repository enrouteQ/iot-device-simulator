// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { LambdaToStepfunctions } from "@aws-solutions-constructs/aws-lambda-stepfunctions";
import { addCfnSuppressRules } from "@aws-solutions-constructs/core";
import { ArnFormat, Aws, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Table } from "aws-cdk-lib/aws-dynamodb";
import { Effect, Policy, PolicyDocument, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Bucket, IBucket } from "aws-cdk-lib/aws-s3";
import {
    Chain, Choice, Condition, DefinitionBody, 
    JsonPath, LogLevel, Map as SFMap, StateMachine, Succeed, TaskInput
} from "aws-cdk-lib/aws-stepfunctions";
import { DynamoAttributeValue, DynamoGetItem, DynamoUpdateItem, LambdaInvoke } from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Construct } from "constructs";

/**
 * ConnectionBuilderConstruct props
 * @interface SimulatorConstructProps
 */
export interface SimulatorConstructProps {
    // Policy for CloudWatch Logs
    readonly cloudWatchLogsPolicy: Policy;
    // IoT endpoint address
    readonly iotEndpointAddress: string;
    // Simulation data DynamoDB table name
    readonly simulationTable: Table;
    // Device Type data DynamoDB table name
    readonly deviceTypeTable: Table;
    //Routes s3 bucket
    readonly routesBucket: Bucket;
    readonly playbacksBucket: Bucket;
    //Unique Suffix
    readonly uniqueSuffix: string;
    /**
     * Solution config properties.
     * Logging level, solution ID, version, source code bucket, and source code prefix
     */
    readonly solutionConfig: {
        sendAnonymousUsage: string;
        solutionId: string;
        solutionVersion: string;
        sourceCodeBucket: IBucket;
        sourceCodePrefix: string;
    };
    // Solution UUID
    readonly uuid: string;
}

/**
 * @class
 * IoT Device Simulator Simulation Engine Construct.
 * It creates a connection builder Lambda function, a connection metadata DynamoDB table, an M2C2 S3 bucket, an IoT rule, and an API Gateway.
 */
export class SimulatorConstruct extends Construct {

    // Connection builder Lambda function
    public simulatorLambdaFunction: LambdaFunction;
    public simulatorStepFunctions: StateMachine;
    public microservicesLambdaFunction: LambdaFunction;

    constructor(scope: Construct, id: string, props: SimulatorConstructProps) {
        super(scope, id);

        const sourceCodeBucket = props.solutionConfig.sourceCodeBucket;
        const sourceCodePrefix = props.solutionConfig.sourceCodePrefix;


        const simulatorLambdaRole = new Role(this, 'EngineLambdaRole', {
            assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
            path: '/',
            inlinePolicies: {
                'S3Policy': new PolicyDocument({
                    statements: [
                        new PolicyStatement({
                            effect: Effect.ALLOW,
                            actions: [
                                's3:GetObject'
                            ],
                            resources: [props.routesBucket.bucketArn]
                        }),
                    ]
                }),
                'DynamoDBPolicy': new PolicyDocument({
                    statements: [
                        new PolicyStatement({
                            effect: Effect.ALLOW,
                            actions: ['dynamodb:GetItem'],
                            resources: [props.simulationTable.tableArn]
                        }),
                    ]
                }),
                'IoTPolicy': new PolicyDocument({
                    statements: [
                        new PolicyStatement({
                            effect: Effect.ALLOW,
                            actions: [
                                'iot:Publish'
                            ],
                            resources: [Stack.of(this).formatArn({ service: 'iot', resource: 'topic', resourceName: '*', arnFormat: ArnFormat.SLASH_RESOURCE_NAME })]
                        })
                    ]
                })
            }
        });
        simulatorLambdaRole.attachInlinePolicy(props.cloudWatchLogsPolicy);
        this.simulatorLambdaFunction = new LambdaFunction(this, 'EngineLambda', {
            code: Code.fromBucket(sourceCodeBucket, `${sourceCodePrefix}/simulator.zip`),
            description: 'IoT Device Simulator function',
            environment: {
                IOT_ENDPOINT: props.iotEndpointAddress,
                SEND_ANONYMOUS_METRIC: props.solutionConfig.sendAnonymousUsage,
                SOLUTION_ID: props.solutionConfig.solutionId,
                VERSION: props.solutionConfig.solutionVersion,
                UUID: props.uuid,
                ROUTE_BUCKET: props.routesBucket.bucketName,
                PLAYBACK_BUCKET: props.playbacksBucket.bucketName
            },
            handler: 'index.handler',
            runtime: Runtime.NODEJS_18_X,
            timeout: Duration.minutes(15),
            role: simulatorLambdaRole
        });
        this.simulatorLambdaFunction.addEnvironment('SIM_TABLE', props.simulationTable.tableName)
        props.routesBucket.grantRead(this.simulatorLambdaFunction.grantPrincipal);
        props.playbacksBucket.grantRead(this.simulatorLambdaFunction.grantPrincipal);
        const simulatorLambdaLogGroup = new LogGroup(this.simulatorLambdaFunction, 'EngineLambda', {
            removalPolicy: RemovalPolicy.DESTROY,
            logGroupName: `/aws/lambda/${Aws.STACK_NAME}-${this.simulatorLambdaFunction.functionName}-${props.uniqueSuffix}`,
            retention: RetentionDays.THREE_MONTHS
          });
        addCfnSuppressRules(simulatorLambdaLogGroup, [{
            id: 'W84',
            reason: 'KMS encryption unnecessary for log group'
        }]);
        
        const getDeviceTypeMap = new SFMap(this, 'getDeviceTypeMap', {
            "itemsPath": "$.simulation.devices",
            "resultPath": "$.simulation.devices",
            "parameters": {
                "typeId.$": "$$.Map.Item.Value.typeId",
                "amount.$": "$$.Map.Item.Value.amount"
            },
            "maxConcurrency": 0,
        });

        const getDeviceTypeInfo = new DynamoGetItem(this, 'getDeviceTypeInfo', {
            "table": props.deviceTypeTable,
            "key": {
                "typeId": DynamoAttributeValue.fromString(JsonPath.stringAt('$.typeId'))
            },
            "resultSelector": {
                "name.$": "$.Item.name",
                "topic.$": "$.Item.topic",
                "payload.$": "$.Item.payload"
            },
            "resultPath": "$.info",
        })

        const simulatorInvoke = new LambdaInvoke(this, 'simulatorInvoke', {
            lambdaFunction: this.simulatorLambdaFunction,
            outputPath: "$.Payload",
            payload: TaskInput.fromJsonPathAt("$"),
            retryOnServiceExceptions: true
        })
        const devicesRunning = new Choice(this, 'devicesRunning?');

        const updateSimTable = new DynamoUpdateItem(this, "UpdateSimTable", {
            "table": props.simulationTable,
            "key": {
                "simId": DynamoAttributeValue.fromString(JsonPath.stringAt('$.simulation.simId'))
            },
            "updateExpression": "SET stage = :stage, updatedAt = :time",
            "expressionAttributeValues": {
                ":stage": DynamoAttributeValue.fromString("sleeping"),
                ":time": DynamoAttributeValue.fromString(JsonPath.stringAt("$$.State.EnteredTime"))
            },
            "conditionExpression": "attribute_exists(simId)"
        });
        const done = new Succeed(this, 'Done');
        updateSimTable.addCatch(done, {errors: ["DynamoDB.ConditionalCheckFailedException"]});

        const definition = Chain
            .start(getDeviceTypeMap.iterator(getDeviceTypeInfo))
            .next(simulatorInvoke.addCatch(updateSimTable, { resultPath: '$.error' }))
            .next(devicesRunning
                .when(
                    Condition.booleanEquals('$.options.restart', true),
                    simulatorInvoke
                )
                .otherwise(updateSimTable.next(done))
            );

        const simulatorLogGroup = new LogGroup(this, 'StepFunctionsLogGroup', {
            retention: RetentionDays.ONE_YEAR,
            logGroupName: `/aws/vendedlogs/states/${Aws.STACK_NAME}-simulatorStepFunctionsLogGroup-${props.uniqueSuffix}`
        });

        addCfnSuppressRules(simulatorLogGroup, [{
            id: 'W84',
            reason: 'KMS encryption unnecessary for log group'
        }]);

        //Microservices Lambda Role
        const microservicesRole = new Role(this, 'MicroservicesRole', {
            assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
            path: '/',
            inlinePolicies: {
                'DynamoDBPolicy': new PolicyDocument({
                    statements: [
                        new PolicyStatement({
                            effect: Effect.ALLOW,
                            actions: [
                                'dynamodb:PutItem',
                                'dynamodb:DeleteItem',
                                'dynamodb:GetItem',
                                'dynamodb:Scan',
                                'dynamodb:Query',
                                'dynamodb:BatchGetItem'
                            ],
                            resources: [
                                props.simulationTable.tableArn,
                                props.deviceTypeTable.tableArn
                            ]
                        }),
                    ]
                })
            }
        });
        microservicesRole.attachInlinePolicy(props.cloudWatchLogsPolicy);

        this.microservicesLambdaFunction = new LambdaFunction(this, 'microservices', {
            code: Code.fromBucket(sourceCodeBucket, `${sourceCodePrefix}/microservices.zip`),
            description: 'IoT Device Simulator microservices function',
            environment: {
                SIMULATIONS_TBL: props.simulationTable.tableName,
                DEVICE_TYPES_TBL: props.deviceTypeTable.tableName,
                SEND_ANONYMOUS_METRIC: props.solutionConfig.sendAnonymousUsage,
                SOLUTION_ID: props.solutionConfig.solutionId,
                VERSION: props.solutionConfig.solutionVersion,
                UUID: props.uuid
            },
            handler: 'index.handler',
            runtime: Runtime.NODEJS_18_X,
            timeout: Duration.minutes(1),
            role: microservicesRole
        });
        const microservicesLambdaLogGroup = new LogGroup(this.microservicesLambdaFunction, 'HelperLambda', {
            removalPolicy: RemovalPolicy.DESTROY,
            logGroupName: `/aws/lambda/${Aws.STACK_NAME}-${this.microservicesLambdaFunction.functionName}-${props.uniqueSuffix}`,
            retention: RetentionDays.THREE_MONTHS
          });
        addCfnSuppressRules(microservicesLambdaLogGroup, [{
            id: 'W84',
            reason: 'KMS encryption unnecessary for log group'
        }]);

        const microservicesToStepfunctions = new LambdaToStepfunctions(this, "StepFunctions", {
            existingLambdaObj: this.microservicesLambdaFunction,
            stateMachineProps: {
                definitionBody: DefinitionBody.fromChainable(definition),
                tracingEnabled: true,
                logs: {
                    destination: simulatorLogGroup,
                    level: LogLevel.ALL,
                    includeExecutionData: false
                }
            },
            stateMachineEnvironmentVariableName: "SIM_STEP_FUNCTION"
        });
        this.simulatorStepFunctions = microservicesToStepfunctions.stateMachine;
        addCfnSuppressRules(this.simulatorStepFunctions, [
            {
                id: 'W11',
                reason: 'CloudWatch logs actions do not support resource level permissions'
            },
            {
                id: 'W12',
                reason: 'CloudWatch logs actions do not support resource level permissions'
            }
        ]);      
    }
}
