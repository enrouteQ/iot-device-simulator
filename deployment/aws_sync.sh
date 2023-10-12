#aws sso login --profile seba
aws s3 sync --profile seba $MAIN_DIRECTORY/deployment/regional-s3-assets/ s3://${DIST_BUCKET_PREFIX}-${REGION}/${SOLUTION_NAME}/${VERSION}/
aws s3 sync --profile seba $MAIN_DIRECTORY/deployment/global-s3-assets/ s3://${DIST_BUCKET_PREFIX}-${REGION}/${SOLUTION_NAME}/${VERSION}/
#aws s3 sync --profile seba $MAIN_DIRECTORY/deployment/regional-s3-assets/console s3://flespi-consoledistributions3bucket51f4e4e5-119o514ovdyll