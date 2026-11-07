import { expect, test, type Page } from '@playwright/test';

/** A small on-sale event without a waiting room, so the journey goes straight to the seat map. */
const EVENT_TITLE = 'Chai & Chaos';
const GOOD_CARD = '4242 4242 4242 4242';
const DECLINED_CARD = '4000 0000 0000 0002';

/** Logs in as the demo user, opens the event, selects two seats and holds them. Ends on the checkout page. */
async function holdTwoSeats(page: Page) {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Try the demo' }).click();
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();

  await page.goto('/');
  await page.getByRole('link', { name: new RegExp(EVENT_TITLE) }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: EVENT_TITLE })).toBeVisible();

  const available = page.getByRole('group', { name: 'Seat map' }).locator('circle[role="button"][aria-label$="available"]');
  await expect(available.first()).toBeVisible();
  // Seats are small circles in an SVG; dispatching the click avoids any overlay or pan/zoom handler.
  await available.nth(0).dispatchEvent('click');
  await available.nth(1).dispatchEvent('click');
  await expect(page.getByRole('region', { name: 'Your seats' }).getByRole('button', { name: /^Remove seat / })).toHaveCount(2);

  await page.getByRole('button', { name: 'Hold 2 seats' }).click();
  await expect(page).toHaveURL(/\/checkout\//);
  await expect(page.getByRole('heading', { name: 'Pay for your seats' })).toBeVisible();
}

async function fillCard(page: Page, number: string) {
  await page.getByLabel('Card number').fill(number);
  await page.getByLabel('Expiry').fill('12/34');
  await page.getByLabel('CVC').fill('123');
  await page.getByLabel('Name on card').fill('Demo Buyer');
}

async function expectTickets(page: Page) {
  await expect(page).toHaveURL(/\/orders\//);
  const tickets = page.getByRole('list', { name: 'Your tickets' }).getByRole('listitem');
  await expect(tickets).toHaveCount(2);
  await expect(page.getByRole('img', { name: /^QR code for ticket SL-/ })).toHaveCount(2);
}

test('demo user holds two seats, pays with a good card and gets two QR tickets', async ({ page }) => {
  await holdTwoSeats(page);
  await fillCard(page, GOOD_CARD);
  await page.getByRole('button', { name: /^Pay / }).click();
  await expectTickets(page);
});

test('a declined card shows the decline, and paying again with a good card succeeds', async ({ page }) => {
  await holdTwoSeats(page);
  await fillCard(page, DECLINED_CARD);
  await page.getByRole('button', { name: /^Pay / }).click();

  const alert = page.getByRole('alert').filter({ hasText: /declined/i });
  await expect(alert).toBeVisible();
  await expect(page).toHaveURL(/\/checkout\//);

  await page.getByLabel('Card number').fill(GOOD_CARD);
  await page.getByRole('button', { name: /^Pay / }).click();
  await expectTickets(page);
});
