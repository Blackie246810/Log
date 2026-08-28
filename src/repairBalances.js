import { repairAllBalances, pool } from './db.js';
import { loadConstants, getCurrency } from './constantsStore.js';

async function main() {
  console.log('Repairing balances — recomputing the entire ledger from Logs...');
  await loadConstants();
  const result = await repairAllBalances(getCurrency());
  console.log('Done.');
  console.log(
    `Final balance — Cash: ${result.cashBalance.toFixed(2)}, Card: ${result.cardBalance.toFixed(2)}, Total: ${result.total.toFixed(2)} (${getCurrency()})`
  );
}

main()
  .catch((err) => {
    console.error('Repair failed:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    pool.end();
  });
