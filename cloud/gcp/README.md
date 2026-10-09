# Multi-VM benchmark on Google Cloud

Removes the "everything on one shared host" limitation: 4 Besu validators, the PEP, the central directory and the load generator run on 7 separate VMs, with network delay injected by `tc netem` (5 ms on validator links, 40 ms on the central directory).

1. Create a Google Cloud account (new accounts get free-trial credit) and a project with billing enabled.
2. Open **Cloud Shell** (the `>_` button in the console). Upload `BC-ZTA_IIoT_Experimental_Code.zip` (Cloud Shell menu ⋮ → Upload) and the two scripts, or `unzip` it and `cd cloud/gcp`.
3. `./run.sh ~/BC-ZTA_IIoT_Experimental_Code.zip` (about 3 hours; it prints a dot per minute while waiting).
4. Download `~/e2e-gcp-results.tar.gz` (Cloud Shell ⋮ → Download) and send it back.
5. **`./cleanup.sh`** to delete the VMs. (VMs also self-delete after 8 h as a safety net.)

Cost: roughly US$0.3/h → about US$1 in total. Free-trial projects are usually limited to 8 vCPUs in total, so the defaults are validators `e2-medium`, PEP and controller `e2-standard-2`, directory `e2-small`; if creation fails with a quota error, send me the message or override `MACHINE_VAL`, `MACHINE_PEP`, `MACHINE_CTL`, `MACHINE_DIR`.
Variables: `ZONE`, `REPS`, `BESU_VERSION`, `NETEM_VAL_MS`, `NETEM_WAN_MS`.

From GitHub instead of a zip: `git clone https://github.com/<user>/bc-zta-iiot-experiments && cd bc-zta-iiot-experiments/cloud/gcp && ./run.sh` (private repository: run `gh auth login` first, or use a personal access token as the password).
