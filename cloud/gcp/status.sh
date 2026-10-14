#!/usr/bin/env bash
# Shows the progress of run_ext.sh (default) or run_ext2.sh (SUITE=ext2): its own log and the log of the experiment currently running on the controller VM.
ZONE="${ZONE:-us-central1-a}"
if [ "${SUITE:-ext}" = "ext2" ]; then D=ext2_output; L="$HOME/ext2.log"; [ "${QUICK:-0}" = "1" ] && { D=ext2_output_quick; L="$HOME/ext2_quick.log"; }
else D=ext_output; L="$HOME/ext.log"; [ "${QUICK:-0}" = "1" ] && { D=ext_output_quick; L="$HOME/ext_quick.log"; }; fi
echo "---- run log (last lines)"; tail -n 8 "${LOG:-$L}" 2>/dev/null
echo "---- finished experiment runs on ctl"
gcloud compute ssh ctl --tunnel-through-iap --zone "$ZONE" --quiet --command "ls ~/$D/*/*results.json 2>/dev/null; echo '---- current experiment log'; ls -t ~/$D/*.log 2>/dev/null | head -1 | xargs -r tail -n 6 | cut -c1-230"
