import { repairAllBalances, pool } from './db.js';

async function main() {
  console.log('Repairing balances — recomputing the entire ledger from Logs...');
  const result = await repairAllBalances();
  console.log('Done.');
  console.log(
    `Final balance — Cash: ₹${result.cashBalance.toFixed(2)}, Card: ₹${result.cardBalance.toFixed(2)}, Total: ₹${result.total.toFixed(2)}`
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