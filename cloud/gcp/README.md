# Multi-VM benchmark on Google Cloud

Removes the "everything on one shared host" limitation: 4 Besu validators, the PEP, the central directory and the load generator run on 7 separate VMs, with network delay injected by `tc netem` (5 ms on validator links, 40 ms on the central directory).

1. Create a Google Cloud account (new accounts get free-trial credit) and a project with billing enabled.
2. Open **Cloud Shell** (the `>_` button in the console). Upload `BC-ZTA_IIoT_Experimental_Code.zip` (Cloud Shell menu ⋮ → Upload) and the two scripts, or `unzip` it and `cd cloud/gcp`.
3. `./run.sh ~/BC-ZTA_IIoT_Experimental_Code.zip` (about 2.5 hours; it prints a dot per minute while waiting).
4. Download `~/e2e-gcp-results.tar.gz` (Cloud Shell ⋮ → Download) and send it back.
5. **`./cleanup.sh`** to delete the VMs. (VMs also self-delete after 8 h as a safety net.)

Cost: 7 × e2-standard-2 ≈ US$0.5/h → about US$1–2 in total. The default regional CPU quota must allow 14 vCPUs; if creation fails with a quota error, request an increase or run with `MACHINE=e2-medium`.
Variables: `ZONE`, `MACHINE`, `REPS`, `BESU_VERSION`, `NETEM_VAL_MS`, `NETEM_WAN_MS`.
