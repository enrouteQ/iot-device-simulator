#aws sso login --profile seba
aws s3 sync --profile seba $MAIN_DIRECTORY/deployment/regional-s3-assets/ s3://${DIST_BUCKET_PREFIX}-${REGION}/${SOLUTION_NAME}/${VERSION}/
aws s3 sync --profile seba $MAIN_DIRECTORY/deployment/global-s3-assets/ s3://${DIST_BUCKET_PREFIX}-${REGION}/${SOLUTION_NAME}/${VERSION}/
# aws s3 sync --profile seba $MAIN_DIRECTORY/deployment/regional-s3-assets/console s3://test-consoledistributions3bucket51f4e4e5-w1f6ez2lwc8j