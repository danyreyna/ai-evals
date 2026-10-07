// bun-types declares `.rejects` matchers as returning void, but they return a promise that must be awaited.
// Asymmetric matchers such as expect.any() are typed as any.
/* oxlint-disable typescript/await-thenable, typescript/no-unsafe-assignment */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
beforeEach(() => {
  resetPayments();
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const client = new PaymentsClient({ apiKey: "test_key" });
const badClient = new PaymentsClient({ apiKey: "wrong_key" });

const card = { amount: 1000, currency: "usd", source: "tok_visa" };
const pendingCard = { ...card, source: "tok_pending" };

function apiError(status: number, code: string, message?: string) {
  return {
    name: "PaymentsApiError",
    status,
    code,
    ...(message !== undefined && { message }),
  };
}

describe("createPayment", () => {
  test("returns a succeeded payment for tok_visa", async () => {
    const payment = await client.createPayment(card);

    expect(payment).toEqual({
      id: expect.stringMatching(/^pay_/),
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
      createdAt: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("returns a pending payment for tok_pending", async () => {
    const payment = await client.createPayment(pendingCard);

    expect(payment).toMatchObject({ source: "tok_pending", status: "pending", amountRefunded: 0 });
  });

  test("assigns a distinct id to each payment", async () => {
    const first = await client.createPayment(card);
    const second = await client.createPayment(card);

    expect(first.id).not.toBe(second.id);
  });

  test("rejects with 402 card_declined for tok_chargeDeclined", async () => {
    await expect(
      client.createPayment({ ...card, source: "tok_chargeDeclined" }),
    ).rejects.toMatchObject(apiError(402, "card_declined", "The card was declined"));
  });

  test("rejects with 402 insufficient_funds for tok_insufficientFunds", async () => {
    await expect(
      client.createPayment({ ...card, source: "tok_insufficientFunds" }),
    ).rejects.toMatchObject(apiError(402, "insufficient_funds", "The card has insufficient funds"));
  });

  test("rejects with 500 processing_error for tok_serverError", async () => {
    await expect(
      client.createPayment({ ...card, source: "tok_serverError" }),
    ).rejects.toMatchObject(
      apiError(500, "processing_error", "An error occurred while processing the payment"),
    );
  });

  test("rejects with 400 invalid_source for an unknown source", async () => {
    await expect(client.createPayment({ ...card, source: "tok_nope" })).rejects.toMatchObject(
      apiError(400, "invalid_source", "Unknown payment source"),
    );
  });

  test.each([
    ["zero", { ...card, amount: 0 }],
    ["negative", { ...card, amount: -5 }],
    ["fractional", { ...card, amount: 10.5 }],
    ["non-numeric", { ...card, amount: "1000" as unknown as number }],
    ["missing currency", { amount: 1000, source: "tok_visa" } as unknown as typeof card],
    ["missing source", { amount: 1000, currency: "usd" } as unknown as typeof card],
  ])("rejects with 400 invalid_request for %s input", async (_name, input) => {
    await expect(client.createPayment(input)).rejects.toMatchObject(
      apiError(400, "invalid_request"),
    );
  });

  test("rejects with 401 unauthorized for a bad API key", async () => {
    await expect(badClient.createPayment(card)).rejects.toMatchObject(
      apiError(401, "unauthorized", "Missing or invalid API key"),
    );
  });
});

describe("getPayment", () => {
  test("returns the payment that was created", async () => {
    const created = await client.createPayment(card);

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects with 404 payment_not_found for an unknown id", async () => {
    await expect(client.getPayment("pay_missing")).rejects.toMatchObject(
      apiError(404, "payment_not_found", "No payment with id pay_missing"),
    );
  });

  test("url-encodes the id so it reaches the server intact", async () => {
    await expect(client.getPayment("a/b c")).rejects.toMatchObject(
      apiError(404, "payment_not_found", "No payment with id a/b c"),
    );
  });

  test("rejects with 401 unauthorized for a bad API key", async () => {
    const created = await client.createPayment(card);

    await expect(badClient.getPayment(created.id)).rejects.toMatchObject(
      apiError(401, "unauthorized"),
    );
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const succeeded = await client.createPayment(card);
    const pending = await client.createPayment(pendingCard);

    expect(await client.listPayments()).toEqual([succeeded, pending]);
  });

  test("returns only payments matching the status filter", async () => {
    await client.createPayment(card);
    const pending = await client.createPayment(pendingCard);

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await client.createPayment(card);

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("reflects status changes made through other methods", async () => {
    const created = await client.createPayment(card);
    const refunded = await client.refundPayment(created.id);

    expect(await client.listPayments({ status: "refunded" })).toEqual([refunded]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([]);
  });

  test("rejects with 401 unauthorized for a bad API key", async () => {
    await expect(badClient.listPayments()).rejects.toMatchObject(apiError(401, "unauthorized"));
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await client.createPayment(card);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
  });

  test("partially refunds when an amount is given", async () => {
    const created = await client.createPayment(card);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toEqual({ ...created, status: "partially_refunded", amountRefunded: 400 });
  });

  test("refunds the remainder after a partial refund", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("persists the refund so getPayment sees it", async () => {
    const created = await client.createPayment(card);
    const refunded = await client.refundPayment(created.id, { amount: 250 });

    expect(await client.getPayment(created.id)).toEqual(refunded);
  });

  test("rejects with 404 payment_not_found for an unknown id", async () => {
    await expect(client.refundPayment("pay_missing")).rejects.toMatchObject(
      apiError(404, "payment_not_found", "No payment with id pay_missing"),
    );
  });

  test("rejects with 409 already_refunded for a fully refunded payment", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id);

    await expect(client.refundPayment(created.id)).rejects.toMatchObject(
      apiError(409, "already_refunded", "Payment already refunded"),
    );
  });

  test("rejects with 409 not_refundable for a pending payment", async () => {
    const created = await client.createPayment(pendingCard);

    await expect(client.refundPayment(created.id)).rejects.toMatchObject(
      apiError(409, "not_refundable", "A pending payment cannot be refunded"),
    );
  });

  test("rejects with 409 not_refundable for a canceled payment", async () => {
    const created = await client.createPayment(pendingCard);
    await client.cancelPayment(created.id);

    await expect(client.refundPayment(created.id)).rejects.toMatchObject(
      apiError(409, "not_refundable", "A canceled payment cannot be refunded"),
    );
  });

  test("rejects with 422 invalid_refund_amount when amount exceeds the payment", async () => {
    const created = await client.createPayment(card);

    await expect(client.refundPayment(created.id, { amount: 1001 })).rejects.toMatchObject(
      apiError(422, "invalid_refund_amount", "Refund amount must be between 1 and 1000"),
    );
  });

  test("rejects with 422 invalid_refund_amount when amount exceeds what remains", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id, { amount: 700 });

    await expect(client.refundPayment(created.id, { amount: 400 })).rejects.toMatchObject(
      apiError(422, "invalid_refund_amount", "Refund amount must be between 1 and 300"),
    );
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 10.5],
  ])("rejects with 422 invalid_refund_amount for a %s amount", async (_name, amount) => {
    const created = await client.createPayment(card);

    await expect(client.refundPayment(created.id, { amount })).rejects.toMatchObject(
      apiError(422, "invalid_refund_amount"),
    );
  });

  test("rejects with 401 unauthorized for a bad API key", async () => {
    const created = await client.createPayment(card);

    await expect(badClient.refundPayment(created.id)).rejects.toMatchObject(
      apiError(401, "unauthorized"),
    );
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment(pendingCard);

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toEqual({ ...created, status: "canceled" });
  });

  test("persists the cancellation so getPayment sees it", async () => {
    const created = await client.createPayment(pendingCard);
    const canceled = await client.cancelPayment(created.id);

    expect(await client.getPayment(created.id)).toEqual(canceled);
  });

  test("rejects with 404 payment_not_found for an unknown id", async () => {
    await expect(client.cancelPayment("pay_missing")).rejects.toMatchObject(
      apiError(404, "payment_not_found", "No payment with id pay_missing"),
    );
  });

  test("rejects with 409 not_cancelable for a succeeded payment", async () => {
    const created = await client.createPayment(card);

    await expect(client.cancelPayment(created.id)).rejects.toMatchObject(
      apiError(409, "not_cancelable", "A succeeded payment cannot be canceled"),
    );
  });

  test("rejects with 409 not_cancelable for an already canceled payment", async () => {
    const created = await client.createPayment(pendingCard);
    await client.cancelPayment(created.id);

    await expect(client.cancelPayment(created.id)).rejects.toMatchObject(
      apiError(409, "not_cancelable", "A canceled payment cannot be canceled"),
    );
  });

  test("rejects with 401 unauthorized for a bad API key", async () => {
    const created = await client.createPayment(pendingCard);

    await expect(badClient.cancelPayment(created.id)).rejects.toMatchObject(
      apiError(401, "unauthorized"),
    );
  });
});

describe("error parsing", () => {
  test("falls back to unknown_error and the status text when the body is not JSON", async () => {
    server.use(
      http.get(
        "https://api.example.com/v1/payments/:id",
        () => new HttpResponse("<html>oops</html>", { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    await expect(client.getPayment("pay_any")).rejects.toMatchObject(
      apiError(502, "unknown_error", "Bad Gateway"),
    );
  });

  test("passes through the server's own error code and message", async () => {
    server.use(
      http.get("https://api.example.com/v1/payments/:id", () =>
        HttpResponse.json(
          { error: { code: "rate_limited", message: "Slow down" } },
          { status: 429 },
        ),
      ),
    );

    await expect(client.getPayment("pay_any")).rejects.toMatchObject(
      apiError(429, "rate_limited", "Slow down"),
    );
  });
});
