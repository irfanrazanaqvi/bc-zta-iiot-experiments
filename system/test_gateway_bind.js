// Local functional check of the optional gateway binding (GATEWAY_BIND=1): a request signed for gateway gw0 recovers a different
// address at gw1, so the public-key-hash comparison in pep.js fails ("sigmismatch"). Message-level test; no chain needed.
const { ethers } = require('ethers');
(async () => {
  const w = ethers.Wallet.createRandom(), did = ethers.id('d'), res = ethers.id('r'), ts = Date.now(), nonce = 'n1';
  const msg = (gw) => `${did}|${res}|${ts}|${nonce}` + (gw ? `|${gw}` : '');
  const pkh = ethers.keccak256(w.address);
  const check = (sig, gw) => ethers.keccak256(ethers.verifyMessage(msg(gw), sig)) === pkh;
  const sigBound = await w.signMessage(msg('gw0')), sigPlain = await w.signMessage(msg(null));
  const r = { bound_accepted_at_own_gateway: check(sigBound, 'gw0'), bound_replayed_at_other_gateway_accepted: check(sigBound, 'gw1'),
              unbound_replayed_at_other_gateway_accepted: check(sigPlain, null) };
  console.log(JSON.stringify(r));
  if (!r.bound_accepted_at_own_gateway || r.bound_replayed_at_other_gateway_accepted) process.exit(1);
  require('fs').writeFileSync(process.argv[2] || '/dev/null', JSON.stringify(r, null, 1));
})();
