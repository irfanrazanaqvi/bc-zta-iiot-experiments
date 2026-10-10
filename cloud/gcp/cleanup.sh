#!/usr/bin/env bash
# Deletes every VM and the firewall rule created by run.sh.
ZONE="${ZONE:-us-central1-a}"
gcloud compute instances delete val1 val2 val3 val4 pep dir ctl --zone "$ZONE" --quiet
gcloud compute firewall-rules delete bczta-internal bczta-iap --quiet
REGION="${ZONE%-*}"
gcloud compute routers nats delete bczta-nat --router bczta-router --region "$REGION" --quiet
gcloud compute routers delete bczta-router --region "$REGION" --quiet
echo "Deleted. Check: gcloud compute instances list   (should be empty)"
