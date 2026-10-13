#!/usr/bin/env bash
# Shows the progress of run_ext.sh: its own log and the log of the experiment currently running on the controller VM.
ZONE="${ZONE:-us-central1-a}"
D=ext_output; [ "${QUICK:-0}" = "1" ] && D=ext_output_quick
echo "---- run_ext log (last lines)"; tail -n 8 "${LOG:-$HOME/ext.log}" 2>/dev/null || tail -n 8 "$HOME/ext_quick.log" 2>/dev/null
echo "---- finished experiment runs on ctl"
gcloud compute ssh ctl --tunnel-through-iap --zone "$ZONE" --quiet --command "ls ~/$D/*/*results.json 2>/dev/null; echo '---- current experiment log'; ls -t ~/$D/*.log 2>/dev/null | head -1 | xargs -r tail -n 6 | cut -c1-230"
