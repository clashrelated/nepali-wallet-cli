import inquirer from 'inquirer';
import { getCredentials } from '../auth/keystore.js';
import { loadSession } from '../auth/session.js';
import { EsewaProvider } from '../providers/esewa.js';
import { KhaltiProvider } from '../providers/khalti.js';
import { spinner, success, error, info } from '../ui/display.js';
import chalk from 'chalk';

// Single bill, single confirmation — by design. Do not add list/CSV/loop variants.
// See AGENTS.md §2 (bulk operations).

const CATEGORIES = [
  { name: 'Internet & TV',       label: 'Internet' },
  { name: 'Electricity & Water', label: 'Electricity' },
  { name: 'TV Payment',          label: 'TV%20Payment' },
  { name: 'Government Services', label: 'Government' },
  { name: 'Education Payment',   label: 'Education' },
  { name: 'Financial Services',  label: 'Financial' },
  { name: 'Search by name...',   label: null },
];

// Prompt the user for a single form field and return their answer
async function promptField(field) {
  const label = field.label || field.key || 'Field';

  if (field.type === 'select' || field.type === 'ui-select' || field.type === 'radio') {
    if (!field.options?.length) return null; // empty — skip for now
    const { val } = await inquirer.prompt([{
      type: 'rawlist',
      name: 'val',
      message: `${label}:`,
      choices: field.options.map(o => ({ name: o.text, value: o.text })),
    }]);
    return val;
  }

  if (field.type === 'date') {
    const hint = field.min && field.max ? ` (${field.min} – ${field.max})`
      : field.min ? ` (from ${field.min})` : field.max ? ` (up to ${field.max})` : '';
    const { val } = await inquirer.prompt([{
      type: 'input',
      name: 'val',
      message: `${label} [YYYY-MM-DD]${hint}:`,
      validate: (v) => {
        if (!v.trim()) return field.required ? 'Required' : true;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return 'Format must be YYYY-MM-DD';
        return true;
      },
    }]);
    return val.trim();
  }

  if (field.type === 'number') {
    const min = field.min ? Number(field.min) : null;
    const max = field.max ? Number(field.max) : null;
    const hint = min !== null && max !== null ? ` (${min}–${max})`
      : min !== null ? ` (min: ${min})`
      : max !== null ? ` (max: ${max})` : '';
    const { val } = await inquirer.prompt([{
      type: 'input',
      name: 'val',
      message: `${label}${hint}:`,
      validate: (v) => {
        const n = Number(v.trim());
        if (isNaN(n) || v.trim().length === 0) return 'Enter a valid number';
        if (min !== null && n < min) return `Minimum is ${min}`;
        if (max !== null && n > max) return `Maximum is ${max}`;
        return true;
      },
    }]);
    return val.trim();
  }

  if (field.type === 'textarea') {
    const { val } = await inquirer.prompt([{
      type: 'input',
      name: 'val',
      message: `${label} (optional):`,
    }]);
    return val.trim();
  }

  // text / email / tel / password
  const { val } = await inquirer.prompt([{
    type: field.type === 'password' ? 'password' : 'input',
    name: 'val',
    message: `${label}:`,
    mask: field.type === 'password' ? '*' : undefined,
    default: field.currentValue || undefined,
    validate: field.required ? v => v.trim().length > 0 ? true : 'Required' : undefined,
  }]);
  return val.trim();
}

// Interactively fill the form on the live browser page.
// After each SELECT change, re-discovers fields so dependent fields appear.
// Returns { fieldValues, fields } — the complete set of answers and field definitions.
async function interactiveFill(client) {
  const fieldValues = {};
  const filled = new Set();
  let fields = await client.discoverFormFields();

  // Up to 15 iterations to handle deep dependency chains
  for (let i = 0; i < 15; i++) {
    const pending = fields.filter(f => !filled.has(f.key));
    if (!pending.length) break;

    for (const field of pending) {
      // Readonly or pre-filled fields: use their current value, no prompt
      if (field.readonly) {
        if (field.currentValue) fieldValues[field.key] = field.currentValue;
        filled.add(field.key);
        continue;
      }

      // ui-select: expand the dropdown live to get the option list before prompting
      if (field.type === 'ui-select' && !field.options?.length) {
        field.options = await client.getUiSelectOptions(field);
      }

      // Show pre-filled readonly siblings as context (e.g. BIN prefix before card number entry)
      const stem = field.key.replace(/\d+$/, '');
      if (stem && stem !== field.key) {
        const readonlySiblings = fields.filter(f =>
          f.readonly && f.currentValue && f.key !== field.key &&
          f.key.replace(/\d+$/, '') === stem
        );
        if (readonlySiblings.length) {
          const hint = readonlySiblings.map(f => `${f.label || f.key}: ${f.currentValue}`).join('  ');
          console.log(chalk.grey(`  (pre-filled — ${hint})`));
        }
      }

      const answer = await promptField(field);
      if (answer === null) continue; // empty dependent select — skip for now

      fieldValues[field.key] = answer;
      filled.add(field.key);

      // Fill this field live in the browser immediately
      await client.fillFormFields([field], { [field.key]: answer });

      // After a SELECT or ui-select, Angular may reveal new dependent fields — restart discovery
      if (field.type === 'select' || field.type === 'ui-select') {
        fields = await client.discoverFormFields();
        break; // restart outer loop so pending list is rebuilt
      }
    }

    // Refresh field list after each full pass
    fields = await client.discoverFormFields();
  }

  return { fieldValues, fields };
}

export async function billCommand(provider, options) {
  if (provider === 'khalti') return khaltiBillCommand(options);
  if (provider !== 'esewa') {
    error('Bill payment is only supported for eSewa and Khalti currently.');
    process.exit(1);
  }

  const creds = await getCredentials(provider);
  const cookies = loadSession(provider);
  if (!creds || !cookies) {
    error(`Not logged in. Run: wallet login ${provider} --show-browser`);
    process.exit(1);
  }

  // Step 1: pick category
  const { catIdx } = await inquirer.prompt([{
    type: 'rawlist',
    name: 'catIdx',
    message: 'Bill category:',
    choices: CATEGORIES.map((c, i) => ({ name: c.name, value: i })),
  }]);
  const category = CATEGORIES[catIdx];

  const client = new EsewaProvider(!options.showBrowser);
  const sessionSpin = spinner('Connecting to eSewa...');
  try {
    const valid = await client.restoreSession(cookies);
    sessionSpin.stop();
    if (!valid) {
      error(`Session expired. Run: wallet login ${provider} --show-browser`);
      await client.close();
      process.exit(1);
    }
  } catch (err) {
    sessionSpin.fail('Error');
    error(err.message);
    await client.close();
    return;
  }

  let product = null;

  if (category.label === null) {
    // Search by name
    const { billerQuery } = await inquirer.prompt([{
      type: 'input',
      name: 'billerQuery',
      message: 'Biller name (e.g. Dishhome, WorldLink, NEA):',
      validate: v => v.trim().length > 1 ? true : 'Enter at least 2 characters',
    }]);

    const searchSpin = spinner(`Searching for "${billerQuery}"...`);
    let results = [];
    try {
      results = await client.searchBillers(billerQuery.trim());
      searchSpin.succeed(`Found ${results.length} result(s)`);
    } catch (err) {
      searchSpin.fail('Error'); error(err.message); await client.close(); return;
    }

    if (!results.length) {
      error(`No results for "${billerQuery}". Try browsing by category.`);
      await client.close(); return;
    }

    const { resultIdx } = await inquirer.prompt([{
      type: 'rawlist', name: 'resultIdx', message: 'Select biller:',
      choices: results.map((r, i) => ({ name: r.name, value: i })),
    }]);

    const navSpin = spinner('Opening biller page...');
    try {
      const payInfo = await client.selectBillerAndGetPaymentCode(billerQuery.trim(), resultIdx);
      if (!payInfo) {
        navSpin.fail('Could not open biller page — screenshot at /tmp/esewa-bill-debug.png');
        await client.close(); return;
      }
      navSpin.succeed(`Opened ${results[resultIdx].name}`);
      product = { name: results[resultIdx].name, code: payInfo.code, productName: payInfo.productName, directUrl: payInfo.url };
    } catch (err) {
      navSpin.fail('Error'); error(err.message); await client.close(); return;
    }
  } else {
    // Browse category
    const listSpin = spinner(`Loading ${category.name} services...`);
    let products = [];
    try {
      products = await client.getBillProductsByCategory(category.label);
      listSpin.succeed(`Found ${products.length} service(s)`);
    } catch (err) {
      listSpin.fail('Error'); error(err.message); await client.close(); return;
    }

    if (!products.length) {
      error('No services found. Try "Search by name..." instead.');
      await client.close(); return;
    }

    const { filterText } = await inquirer.prompt([{
      type: 'input', name: 'filterText',
      message: `Filter services (${products.length} found — type to narrow, or Enter for all):`,
    }]);
    const filtered = filterText.trim()
      ? products.filter(p => p.name.toLowerCase().includes(filterText.trim().toLowerCase()))
      : products;

    if (!filtered.length) {
      error(`No services match "${filterText}".`); await client.close(); return;
    }

    const displayList = filtered.slice(0, 50);
    if (filtered.length > 50) info(`Showing first 50 of ${filtered.length}. Narrow your filter for more.`);

    const { productIdx } = await inquirer.prompt([{
      type: 'rawlist', name: 'productIdx', message: 'Select service:',
      choices: displayList.map((p, i) => ({ name: p.name, value: i })),
    }]);
    const chosen = displayList[productIdx];

    const navSpin = spinner('Opening service page...');
    try {
      const payInfo = await client.selectCategoryProductAndGetCode(category.label, chosen.name, chosen.code);
      if (!payInfo) {
        navSpin.fail('Could not open service page — screenshot at /tmp/esewa-bill-debug.png');
        await client.close(); return;
      }
      navSpin.succeed(`Opened ${chosen.name}`);
      product = { name: chosen.name, code: payInfo.code, productName: payInfo.productName, directUrl: payInfo.directUrl };
    } catch (err) {
      navSpin.fail('Error'); error(err.message); await client.close(); return;
    }
  }

  // Step 2: navigate to payment form and fill fields interactively
  const formSpin = spinner('Loading payment form...');
  try {
    await client.navigateToPaymentForm(product.directUrl);
    formSpin.stop();
  } catch (err) {
    formSpin.fail('Error'); error(err.message); await client.close(); return;
  }

  if (await client.isExternalBookingPage()) {
    info(`${product.name} requires booking directly on their website — no eSewa payment form available.`);
    await client.close(); return;
  }

  console.log();
  console.log(chalk.bold(`  ${product.name} — Fill in payment details`));
  console.log();

  let fieldValues = {};
  let formFields = [];
  try {
    const filled = await interactiveFill(client);
    fieldValues = filled.fieldValues;
    formFields = filled.fields;
  } catch (err) {
    error(err.message); await client.close(); return;
  }

  // Step 3: if the form has a CHECK button, click it now and show bill info
  let billInfo = null;
  let isDirectProceed = true;
  let selectedPlan = null;

  const isCheck = await client.hasCheckButton();
  if (isCheck) {
    isDirectProceed = false;
    const fetchSpin = spinner('Fetching bill details...');
    try {
      const result = await client.checkAndGetBillInfo();
      fetchSpin.stop();
      if (!result.success) { error(result.error); await client.close(); return; }
      billInfo = result.billInfo;
    } catch (err) {
      fetchSpin.fail('Error'); error(err.message); await client.close(); return;
    }
  }

  // Step 4: display summary
  console.log();
  console.log(chalk.bold(`  ${product.name} — Summary`));
  if (isDirectProceed) {
    for (const field of formFields) {
      const v = fieldValues[field.key];
      if (v) console.log(`  ${chalk.grey((field.label || field.key).padEnd(22))} ${v}`);
    }
  } else if (billInfo) {
    if (billInfo.fields && Object.keys(billInfo.fields).length) {
      for (const [k, v] of Object.entries(billInfo.fields)) {
        if (v && k) console.log(`  ${chalk.grey(k.padEnd(22))} ${v}`);
      }
    }
    if (billInfo.amount) console.log(`  ${'Amount'.padEnd(22)} ${chalk.green.bold(billInfo.amount)}`);
    if (!Object.keys(billInfo?.fields || {}).length && !billInfo?.amount) {
      info('No account details returned — verify before confirming.');
    }
  }
  console.log();

  // Step 5: plan selection (for CHECK services that offer recharge plans)
  if (!isDirectProceed && billInfo?.plans?.length) {
    const { planIdx } = await inquirer.prompt([{
      type: 'rawlist', name: 'planIdx', message: 'Select recharge plan:',
      choices: billInfo.plans.map((p, i) => ({ name: p.text, value: i })),
    }]);
    selectedPlan = billInfo.plans[planIdx];
    console.log();
  }

  // Step 6: confirm
  const { confirm } = await inquirer.prompt([{
    type: 'rawlist', name: 'confirm', message: 'Proceed with payment?', choices: ['Yes', 'No'],
  }]);
  if (confirm !== 'Yes') { info('Cancelled.'); await client.close(); return; }

  // Step 7: MPIN
  const { mpin } = await inquirer.prompt([{
    type: 'password', name: 'mpin', message: 'Enter your MPIN:', mask: '*',
    validate: v => v.length >= 4 ? true : 'MPIN must be at least 4 digits',
  }]);

  // Step 8: pay (re-navigates and replays the whole fill + payment)
  const paySpin = spinner('Processing payment...');
  try {
    const result = await client.billPay(product.directUrl, fieldValues, mpin, selectedPlan);
    await client.close();

    if (result.success) {
      paySpin.succeed('Bill paid successfully!');
      success(`${product.name} bill paid`);
      if (result.ref) success(`Reference: ${result.ref}`);
    } else {
      paySpin.fail('Payment failed');
      error(result.error);
    }
  } catch (err) {
    paySpin.fail('Error');
    error(err.message);
    await client.close();
  }
}

// ===========================================================================
// Khalti bill command — generic UI-driven flow.
// Curated top-level picker, then drill into sub-cards until a form is reached,
// dynamically discover its inputs, prompt user, click action, walk through
// modal if it appears, scrape result.
// ===========================================================================

const KHALTI_FEATURED = [
  'Internet/TV',
  'Data/Voice Pack',
  'Government Services',
  'Landline',
  'Insurance & Suraksha',
  'EMI & Credit Card',
  'Banking Services',
  'Education',
  'Health',
  'Daily Essentials',
];

// Pick from a possibly-long sub-card list. ≤30 items → straight rawlist.
// >30 → ask for a partial name first, filter, then rawlist the matches.
async function pickFromSubCards(subCards, message) {
  if (subCards.length <= 30) {
    const { pick } = await inquirer.prompt([{
      type: 'rawlist',
      name: 'pick',
      message,
      choices: subCards,
      pageSize: 15,
    }]);
    return pick;
  }
  while (true) {
    const { query } = await inquirer.prompt([{
      type: 'input',
      name: 'query',
      message: `${subCards.length} services available. Type part of the name to filter:`,
      validate: (v) => v.trim().length >= 2 ? true : 'Enter at least 2 characters',
    }]);
    const lower = query.trim().toLowerCase();
    const matches = subCards.filter((s) => s.toLowerCase().includes(lower));
    if (!matches.length) {
      console.log(chalk.grey('  No matches. Try again.'));
      continue;
    }
    if (matches.length === 1) {
      console.log(chalk.grey(`  → ${matches[0]}`));
      return matches[0];
    }
    if (matches.length > 30) {
      console.log(chalk.grey(`  ${matches.length} matches — too many, narrow it down.`));
      continue;
    }
    const { pick } = await inquirer.prompt([{
      type: 'rawlist',
      name: 'pick',
      message: `${matches.length} matches. Pick one:`,
      choices: [...matches, new inquirer.Separator(), '(search again)'],
      pageSize: 15,
    }]);
    if (pick === '(search again)') continue;
    return pick;
  }
}

async function khaltiBillCommand(options) {
  const provider = 'khalti';
  const creds = await getCredentials(provider);
  const cookies = loadSession(provider);
  if (!creds || !cookies) {
    error(`Not logged in. Run: wallet login ${provider} --show-browser`);
    process.exit(1);
  }

  const client = new KhaltiProvider(!options?.showBrowser);
  const sessionSpin = spinner('Connecting to Khalti...');
  try {
    const valid = await client.restoreSession(cookies);
    sessionSpin.stop();
    if (!valid) {
      error(`Session expired. Run: wallet login ${provider} --show-browser`);
      await client.close();
      process.exit(1);
    }

    const allCards = await client.listBillTopCards();
    const featured = KHALTI_FEATURED.filter((f) => allCards.includes(f));
    const others = allCards.filter((c) => !featured.includes(c)).sort();

    const { topPick } = await inquirer.prompt([{
      type: 'rawlist',
      name: 'topPick',
      message: 'Bill category:',
      choices: [
        ...featured,
        new inquirer.Separator('-- other categories --'),
        ...others,
      ],
    }]);

    info(`Opening "${topPick}"...`);
    let state = await client.clickBillCard(topPick);

    // Drill into sub-cards until we hit a form
    let depth = 0;
    while (state.kind === 'category' && depth < 5) {
      depth++;
      if (!state.subCards.length) {
        error('No sub-services available on this page.');
        await client.close();
        return;
      }
      const subPick = await pickFromSubCards(state.subCards, 'Service:');
      info(`Opening "${subPick}"...`);
      state = await client.clickBillCard(subPick);
    }

    if (state.kind !== 'form') {
      if (state.url?.includes('/bazaar/') && /\/product$/.test(state.url || '')) {
        error("This service uses Khalti's Bazaar product UI which the CLI doesn't support yet.");
        info(`URL: ${state.url}`);
        info('Pay this one through the Khalti web/mobile app.');
      } else {
        error(`Unexpected page state: ${state.kind} (url: ${state.url}). Khalti may have changed this service.`);
      }
      await client.close();
      return;
    }

    if (!state.inputs.length) {
      error('No fillable form fields detected. Khalti may have changed this service.');
      await client.close();
      return;
    }

    // Prompt for each field
    const values = {};
    for (const f of state.inputs) {
      const label = f.label || f.placeholder || f.name;
      const { val } = await inquirer.prompt([{
        type: 'input',
        name: 'val',
        message: `${label}${f.placeholder && f.placeholder !== label ? ` (${f.placeholder})` : ''}:`,
        validate: (v) => v.trim().length > 0 ? true : `${label} is required`,
      }]);
      values[f.name] = val.trim();
    }

    await client.fillBillForm(values);

    // Pick action button — prefer in this order
    const actionPriority = ['PROCEED', 'Check', 'Pay', 'PAY', 'Submit', 'Next'];
    const action = actionPriority.find((a) => state.actions.some((x) => x.toLowerCase() === a.toLowerCase())) || state.actions[0];
    if (!action) {
      error('No action button (PROCEED/PAY/Next/Submit/Check) detected on this form.');
      if (state.url?.includes('/bazaar/')) {
        info('Bazaar services sometimes use custom button text. Try the Khalti app for this one.');
      }
      await client.close();
      return;
    }

    console.log();
    console.log(chalk.bold('  Bill Details'));
    for (const [k, v] of Object.entries(values)) console.log(`  ${chalk.grey(k.padEnd(18))} ${v}`);
    console.log();

    const { confirm } = await inquirer.prompt([{
      type: 'rawlist',
      name: 'confirm',
      message: `Click "${action}" on Khalti?`,
      choices: ['Yes', 'No'],
    }]);
    if (confirm !== 'Yes') { info('Cancelled.'); await client.close(); return; }

    const actSpin = spinner(`Clicking ${action}...`);
    const actResult = await client.clickBillAction(action);
    actSpin.stop();
    if (!actResult.success) {
      error(actResult.error);
      await client.close();
      return;
    }

    // After action, page may show a modal (with summary), a new form (e.g. CHECK
    // returned bill amount → PAY), or a result toast.
    let next = await client.getBillState();

    // Walk through any intermediate forms (e.g., CHECK → PAY)
    let stepCount = 0;
    while (next.kind === 'form' && stepCount < 3) {
      stepCount++;
      // New form fields after CHECK — re-prompt for any not-yet-filled ones
      const newFields = next.inputs.filter((f) => !(f.name in values));
      const newValues = {};
      for (const f of newFields) {
        const label = f.label || f.placeholder || f.name;
        const { val } = await inquirer.prompt([{
          type: 'input',
          name: 'val',
          message: `${label}:`,
          validate: (v) => v.trim().length > 0 ? true : `${label} is required`,
        }]);
        newValues[f.name] = val.trim();
      }
      if (Object.keys(newValues).length) {
        await client.fillBillForm(newValues);
        Object.assign(values, newValues);
      }

      const next2Action = ['Pay', 'PAY', 'PROCEED', 'Submit'].find((a) =>
        next.actions.some((x) => x.toLowerCase() === a.toLowerCase())
      ) || next.actions[0];
      if (!next2Action) {
        error('No action button on follow-up form.');
        await client.close();
        return;
      }

      console.log();
      console.log(chalk.bold('  Updated bill state'));
      for (const [k, v] of Object.entries(values)) console.log(`  ${chalk.grey(k.padEnd(18))} ${v}`);
      console.log();

      const { stepConfirm } = await inquirer.prompt([{
        type: 'rawlist',
        name: 'stepConfirm',
        message: `Click "${next2Action}"?`,
        choices: ['Yes', 'No'],
      }]);
      if (stepConfirm !== 'Yes') { info('Cancelled.'); await client.close(); return; }

      const stepSpin = spinner(`Clicking ${next2Action}...`);
      const stepRes = await client.clickBillAction(next2Action);
      stepSpin.stop();
      if (!stepRes.success) {
        error(stepRes.error);
        await client.close();
        return;
      }
      next = await client.getBillState();
    }

    if (next.kind === 'modal') {
      console.log();
      console.log(chalk.bold(`  ${next.summary?.title || 'Confirm'}`));
      for (const [k, v] of Object.entries(next.summary?.fields || {})) {
        console.log(`  ${chalk.grey(k.padEnd(18))} ${v}`);
      }
      console.log();
      const { finalConfirm } = await inquirer.prompt([{
        type: 'rawlist',
        name: 'finalConfirm',
        message: 'Click Continue to submit?',
        choices: ['No', 'Yes'],
      }]);
      if (finalConfirm !== 'Yes') {
        info('Cancelled before final submission.');
        await client.close();
        return;
      }
      const finalSpin = spinner('Submitting...');
      const result = await client.confirmBillModal();
      await client.close();
      if (result.success) {
        finalSpin.succeed('Bill paid!');
        success(result.message || 'Payment submitted.');
      } else {
        finalSpin.fail('Payment failed');
        error(result.error);
      }
      return;
    }

    // No modal — must be a direct result
    const result = await client._scrapeBillResult();
    await client.close();
    if (result.success) {
      success(result.message || 'Bill paid.');
    } else {
      error(result.error);
    }
  } catch (err) {
    sessionSpin.fail('Error');
    error(err.message);
    await client.close();
  }
}
