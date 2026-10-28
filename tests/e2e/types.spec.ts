// SPDX-License-Identifier: GPL-3.0-only
// Cards, identities, secure notes and custom fields (mockups item-types): the "+" menu, each type's form and page,
// what lands on the server, the list's type buttons combined with folders, and card copy buttons.
import type { Page } from '@playwright/test';
import { CORPUS_PORT, e2eCreds } from './accounts';
import { expect, test } from './fixtures';
import { clipboard, finishFirstRun, shot, signIn, signOut, watchErrors } from './helpers';
import { createItems, deleteFolder, deleteItems, ensureFolder, serverItems } from './inpage-helpers';

test.describe.configure({ mode: 'serial' });

const creds = e2eCreds();
const errors: string[] = [];
const RUN = `T${Date.now().toString(36)}`;

test.beforeAll(async ({ popup, ctx }) => {
  // What earlier runs made (names start with "T" and the run's id), so folder counts don't creep up.
  await deleteItems(LEFTOVERS);
  await signOut(() => popup());
  for (const x of ctx.pages()) if (x.url().startsWith('chrome-extension://')) await x.close();
  const p0 = await ctx.newPage();
  await p0.goto(`http://corpus.lw.test:${CORPUS_PORT}/stacked.html`);
  const p = await popup(p0);
  watchErrors(p, errors);
  await signIn(p, creds.main.email, creds.main.password);
  await finishFirstRun(p);
  await p.close();
  await p0.close();
});
const LEFTOVERS = /^(T[0-9a-z]{8} |Visa •4241$|Alex Rivera T[0-9a-z]{8}$)/;
test.afterAll(async () => {
  // The other specs count folders and items: leave the account as it was.
  await deleteItems(LEFTOVERS);
  await deleteFolder('E2E Cards');
  if (errors.length) console.log('console errors:\n' + errors.join('\n'));
  expect(errors, 'console errors').toEqual([]);
});

async function open(popup: (t?: Page, o?: { theme?: 'light' | 'dark' }) => Promise<Page>, theme: 'light' | 'dark' = 'light') {
  const p = await popup(undefined, { theme });
  watchErrors(p, errors);
  await p.waitForSelector('.row, .card, .empty');
  return p;
}

async function newItem(p: Page, key: string) {
  await p.click('button[aria-label="New item"]');
  await expect(p.locator('.newmenu .it')).toHaveText([/Login\s*L/, /Card\s*C/, /Identity\s*I/, /Secure note\s*N/]);
  await expect(p.locator('.newmenu .it.sel')).toHaveText(/Login/);
  await p.keyboard.press(key);
  await expect(p.locator('.newmenu')).toHaveCount(0);
}

async function save(p: Page) {
  await p.click('.hdr button[type=submit]');
  await expect(p.locator('#toast')).toContainText('Saved to');
  await expect(p.locator('.hdr .btn.sec', { hasText: 'Edit' })).toBeVisible();
}

test('"+" menu: Login is first and Enter makes one; Esc closes it; C makes a card that lands on the server', async ({ popup }) => {
  const p = await open(popup);
  await p.click('button[aria-label="New item"]');
  await shot(p, 'types-plus-menu-light', 2);
  await p.keyboard.press('Escape');
  await expect(p.locator('.newmenu')).toHaveCount(0);
  await expect(p.locator('#q')).toHaveValue('');
  await p.click('button[aria-label="New item"]');
  await p.keyboard.press('Enter');
  await expect(p.locator('.hdr h1')).toHaveText('New login');
  await p.click('.hdr button[aria-label="Cancel"]');
  await expect(p.locator('#q')).toBeVisible();

  await newItem(p, 'c');
  await expect(p.locator('.hdr h1')).toHaveText('New card');
  await expect(p.locator('#f-number')).toBeFocused();
  await expect(p.locator('.cardface')).toHaveClass(/cf-empty/);
  await p.keyboard.type('4242424242424242');
  await expect(p.locator('#f-number')).toHaveValue('4242 4242 4242 4242');
  await expect(p.locator('.cf-brand')).toHaveText('VISA');
  await expect(p.locator('.cf-num')).toHaveText('•••• •••• •••• 4242');
  await p.fill('#f-holder', 'Alex Rivera');
  await p.click('#f-exp');
  await p.keyboard.type('0828');
  await expect(p.locator('#f-exp')).toHaveValue('08 / 28');
  await p.fill('#f-code', '123');
  await expect(p.locator('#f-name')).toHaveAttribute('placeholder', 'Visa •4242');
  await p.fill('#f-name', `${RUN} Sapphire`);
  await expect(p.locator('.field.err')).toHaveCount(0);
  await shot(p, 'types-card-form-light', 2);
  await save(p);
  await expect(p.locator('.cardface .cf-bot')).toContainText('Alex Rivera');
  await expect(p.locator('.kv', { hasText: 'Number' })).toContainText('•••• •••• •••• 4242');
  await p.locator('button[aria-label="Show number"]').click();
  await expect(p.locator('.kv', { hasText: 'Number' })).toContainText('4242 4242 4242 4242');
  await expect(p.locator('.kv', { hasText: 'Security code' })).toContainText('•••');
  await shot(p, 'types-card-view-light', 2);

  const [c] = await serverItems(`${RUN} Sapphire`);
  expect(c?.type).toBe(3);
  expect(c?.card).toMatchObject({ number: '4242424242424242', brand: 'Visa', expMonth: '8', expYear: '2028', code: '123', cardholderName: 'Alex Rivera' });

  // Edit: change one thing; the rest stays as it was on the server.
  await p.locator('.hdr .btn.sec', { hasText: 'Edit' }).click();
  await expect(p.locator('#f-number')).toHaveClass(/masked/);
  await p.fill('#f-holder', 'Alex J Rivera');
  await save(p);
  await expect.poll(async () => (await serverItems(`${RUN} Sapphire`))[0]?.card).toMatchObject({ number: '4242424242424242', code: '123', cardholderName: 'Alex J Rivera' });
  await p.close();
});

test('card form: a mistyped number and an expired date warn but still save; an empty name becomes "Visa •4241"', async ({ popup }) => {
  const p = await open(popup);
  await newItem(p, 'c');
  await expect(p.locator('#f-number')).toBeFocused();
  await p.keyboard.type('4242424242424241');
  await expect(p.locator('.field.err .f-msg')).toHaveText("This number doesn't look right. Check it against the card.");
  await p.click('#f-exp');
  await p.keyboard.type('0120');
  await expect(p.locator('.field.err .f-msg', { hasText: 'Expired' })).toBeVisible();
  await p.fill('#f-holder', `${RUN} Typo`);
  await shot(p, 'types-card-warn-light', 2);
  await save(p);
  await expect(p.locator('.hdr h1')).toHaveText('Visa •4241');
  await expect(p.locator('.kv .pill.bad')).toHaveText('Expired');
  const all = await serverItems('Visa •4241');
  expect(all.some((x) => x.card?.cardholderName === `${RUN} Typo` && x.card?.expYear === '2020')).toBe(true);
  await p.close();
});

test('identity: the short form, a "Passport number" chip, then the page with the address as one block', async ({ popup }) => {
  const p = await open(popup);
  await newItem(p, 'i');
  await expect(p.locator('.hdr h1')).toHaveText('New identity');
  await expect(p.locator('#f-firstName')).toBeFocused();
  await p.keyboard.type('Alex');
  await p.fill('#f-lastName', `Rivera ${RUN}`);
  await p.fill('#f-email', 'alex@example.com');
  await p.fill('#f-phone', '(305) 555-0142');
  await p.fill('#f-address1', '120 Ocean Drive');
  await p.fill('#f-city', 'Miami');
  await p.fill('#f-state', 'FL');
  await p.fill('#f-postalCode', '33139');
  await expect(p.locator('.add-chip')).toHaveCount(10);
  await p.locator('.add-chip', { hasText: 'Passport number' }).click();
  await expect(p.locator('#f-passportNumber')).toBeFocused();
  await p.keyboard.type('X1234567');
  await expect(p.locator('.add-chip')).toHaveCount(9);
  await expect(p.locator('#f-name')).toHaveAttribute('placeholder', `Alex Rivera ${RUN}`);
  await shot(p, 'types-identity-form-light', 2);
  await save(p);
  await expect(p.locator('.hdr h1')).toHaveText(`Alex Rivera ${RUN}`);
  await expect(p.locator('.kv .addr')).toHaveText('120 Ocean Drive\nMiami, FL 33139');
  await expect(p.locator('.kv', { hasText: 'Passport' })).toContainText('••••••••');
  await shot(p, 'types-identity-view-light', 2);
  const [it] = await serverItems(`Alex Rivera ${RUN}`);
  expect(it?.type).toBe(4);
  expect(it?.identity).toMatchObject({ firstName: 'Alex', email: 'alex@example.com', city: 'Miami', postalCode: '33139', passportNumber: 'X1234567', ssn: null });
  // Copy the address as it pastes.
  await p.locator('button[aria-label="Copy address"]').click();
  expect((await clipboard(p.context())).replace(/\r\n/g, '\n')).toBe('120 Ocean Drive\nMiami, FL 33139'); // Windows stores CRLF
  await p.close();
});

test('secure note with custom fields: text, hidden and checkbox fields save and show; Remove drops one', async ({ popup }) => {
  const p = await open(popup, 'dark');
  await newItem(p, 'n');
  await expect(p.locator('.hdr h1')).toHaveText('New note');
  await p.fill('#f-name', `${RUN} Wi-Fi`);
  await p.fill('#f-notes', 'Network: Harbor-5G');
  await p.locator('button', { hasText: 'Add text field' }).click();
  await expect(p.locator('#f-cf0')).toBeFocused();
  await p.keyboard.type('Member ID');
  await p.locator('input[aria-label="Field 1 value"]').fill('88123004');
  await p.locator('button', { hasText: 'Add hidden field' }).click();
  await expect(p.locator('#f-cf1')).toBeFocused();
  await p.keyboard.type('PIN');
  await p.locator('input[aria-label="Field 2 value"]').fill('1234');
  await expect(p.locator('input[aria-label="Field 2 value"]')).toHaveClass(/masked/);
  await p.locator('button', { hasText: 'Add checkbox' }).click();
  await expect(p.locator('#f-cf2')).toBeFocused();
  await p.keyboard.type('Guest network');
  await p.locator('.cf .sw').click();
  await p.locator('button', { hasText: 'Add text field' }).click();
  await expect(p.locator('#f-cf3')).toBeFocused();
  await p.keyboard.type('Scratch');
  await p.locator('button[aria-label="Remove field 4"]').click();
  await expect(p.locator('.cf')).toHaveCount(3);
  await shot(p, 'types-note-fields-dark', 2);
  await save(p);
  await expect(p.locator('.kv', { hasText: 'Member ID' })).toContainText('88123004');
  await expect(p.locator('.kv', { hasText: 'PIN' })).toContainText('••••');
  await expect(p.locator('.kv', { hasText: 'Guest network' })).toContainText('Yes');
  await shot(p, 'types-note-view-dark', 2);
  const [n] = await serverItems(`${RUN} Wi-Fi`);
  expect(n?.type).toBe(2);
  expect(n?.notes).toBe('Network: Harbor-5G');
  expect(n?.fields).toEqual([
    { name: 'Member ID', value: '88123004', type: 0, linkedId: null },
    { name: 'PIN', value: '1234', type: 1, linkedId: null },
    { name: 'Guest network', value: 'true', type: 2, linkedId: null },
  ]);
  await p.close();
});

test('list: the type buttons combine with a folder ("Cards in E2E Cards"), stick across opens, Alt+2 toggles; card rows copy', async ({ popup, ctx }) => {
  const folder = await ensureFolder('E2E Cards');
  await createItems([
    { type: 3, name: `${RUN} Company Amex`, folderId: folder, card: { cardholderName: 'Alex Rivera', brand: 'Amex', number: '378282246310005', expMonth: '11', expYear: '2027', code: '1234' } },
    { type: 3, name: `${RUN} Travel MC`, folderId: folder, card: { cardholderName: 'Alex Rivera', brand: 'Mastercard', number: '5555555555554444', expMonth: '3', expYear: '2025', code: '321' } },
  ]);
  let p = await open(popup);
  await p.click('button[aria-label="Sync now"]');
  await expect(p.locator('#toast')).toContainText('Vault synced');
  let head = p.locator('div.sec.typed');
  await p.locator('.types button[aria-label="Cards"]').click();
  await expect(head).toContainText('Cards');
  await expect(p.locator('#q')).toHaveAttribute('placeholder', 'Search cards');
  await expect(p.locator('.card')).toHaveCount(0); // this site's logins hide while cards are picked
  await p.locator('.rail .chip', { hasText: 'E2E Cards' }).click();
  // (Earlier runs leave their cards in the folder too: count this run's, and that every row is a card.)
  await expect(head).toHaveText(/^Cards in E2E Cards\s*\d+$/);
  await expect(p.locator('#list .row', { hasText: RUN })).toHaveCount(2);
  expect(await p.locator('#list .row .tile:not(.bt)').count()).toBe(0);
  await expect(p.locator('#list .row', { hasText: `${RUN} Company Amex` }).locator('.tile.bt-amex')).toHaveCount(1);
  await expect(p.locator('#list .row', { hasText: `${RUN} Travel MC` }).locator('.tile.bt-mastercard')).toHaveCount(1);
  await expect(p.locator('#list .row', { hasText: `${RUN} Travel MC` }).locator('.un .bad')).toHaveText(' · expired 03/25');
  await expect(p.locator('.types button[aria-label="Identities"]')).toHaveClass(/dim/);
  await shot(p, 'types-filter-cards-folder-light', 2);
  await p.locator('#list .row', { hasText: `${RUN} Company Amex` }).locator('button[aria-label="Copy card number"]').click();
  await expect(p.locator('#toast')).toContainText('Number copied');
  expect(await clipboard(ctx)).toBe('378282246310005');
  await p.close();

  // Sticks across opens; Alt+2 (cards) again shows every type in the folder.
  p = await open(popup);
  head = p.locator('div.sec.typed');
  await expect(head).toHaveText(/^Cards in E2E Cards\s*\d+$/);
  await p.keyboard.press('Alt+2');
  await expect(head).toHaveText(/^E2E Cards\s*\d+$/);
  await p.keyboard.press('Alt+3');
  await expect(p.locator('.empty h3')).toHaveText('No identities in E2E Cards');
  await p.locator('.empty .btn.sec', { hasText: 'Show every type' }).click();
  await p.locator('.rail .chip', { hasText: 'All' }).click();
  await expect(head).toHaveText(/^All items/);
  // Enter on a card opens it (there's nothing to fill).
  await p.fill('#q', `${RUN} Company`);
  await p.keyboard.press('Enter');
  await expect(p.locator('.cardface.cf-amex')).toBeVisible();
  await expect(p.locator('.hdr .tile.bt-amex')).toBeVisible();
  await shot(p, 'types-card-view-amex-light', 2);
  await p.close();
});
