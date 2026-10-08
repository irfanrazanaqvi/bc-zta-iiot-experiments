#!/usr/bin/env bash
# Deletes every VM and the firewall rule created by run.sh.
ZONE="${ZONE:-us-central1-a}"
gcloud compute instances delete val1 val2 val3 val4 pep dir ctl --zone "$ZONE" --quiet
gcloud compute firewall-rules delete bczta-internal --quiet
echo "Deleted. Check: gcloud compute instances list   (should be empty)"
