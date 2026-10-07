import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const client = new PaymentsClient({ apiKey: "test_key" });
const badKeyClient = new PaymentsClient({ apiKey: "wrong_key" });

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

/** Awaits a call that must reject and returns the thrown error for assertions. */
async function rejection(call: Promise<unknown>): Promise<PaymentsApiError> {
  let error: unknown;
  try {
    await call;
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(PaymentsApiError);
  return error as PaymentsApiError;
}

const card = { amount: 1000, currency: "usd", source: "tok_visa" };

describe("createPayment", () => {
  test("creates a succeeded payment echoing the input", async () => {
    const payment = await client.createPayment(card);

    const { id, createdAt, ...rest } = payment;
    expect(rest).toEqual({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(id.startsWith("pay_")).toBe(true);
    expect(new Date(createdAt).toISOString()).toBe(createdAt);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await client.createPayment({ ...card, source: "tok_pending" });

    expect(payment.status).toBe("pending");
    expect(payment.source).toBe("tok_pending");
    expect(payment.amountRefunded).toBe(0);
  });

  test("gives each payment a unique id", async () => {
    const a = await client.createPayment(card);
    const b = await client.createPayment(card);

    expect(a.id).not.toBe(b.id);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const error = await rejection(badKeyClient.createPayment(card));

    expect(error.status).toBe(401);
    expect(error.code).toBe("unauthorized");
    expect(error.message).toBe("Missing or invalid API key");
  });

  test.each([
    ["zero amount", { ...card, amount: 0 }],
    ["negative amount", { ...card, amount: -5 }],
    ["fractional amount", { ...card, amount: 10.5 }],
    ["non-numeric amount", { ...card, amount: "100" as unknown as number }],
    ["missing currency", { ...card, currency: undefined as unknown as string }],
    ["missing source", { ...card, source: undefined as unknown as string }],
  ])("rejects %s with 400 invalid_request", async (_name, input) => {
    const error = await rejection(client.createPayment(input));

    expect(error.status).toBe(400);
    expect(error.code).toBe("invalid_request");
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    const error = await rejection(client.createPayment({ ...card, source: "tok_nope" }));

    expect(error.status).toBe(400);
    expect(error.code).toBe("invalid_source");
    expect(error.message).toBe("Unknown payment source");
  });

  test("rejects a declined card with 402 card_declined", async () => {
    const error = await rejection(client.createPayment({ ...card, source: "tok_chargeDeclined" }));

    expect(error.status).toBe(402);
    expect(error.code).toBe("card_declined");
    expect(error.message).toBe("The card was declined");
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    const error = await rejection(
      client.createPayment({ ...card, source: "tok_insufficientFunds" }),
    );

    expect(error.status).toBe(402);
    expect(error.code).toBe("insufficient_funds");
  });

  test("surfaces a server failure as 500 processing_error", async () => {
    const error = await rejection(client.createPayment({ ...card, source: "tok_serverError" }));

    expect(error.status).toBe(500);
    expect(error.code).toBe("processing_error");
  });

  test("does not store a payment that failed", async () => {
    await rejection(client.createPayment({ ...card, source: "tok_chargeDeclined" }));

    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns the stored payment", async () => {
    const created = await client.createPayment(card);

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("returns the current state after a mutation", async () => {
    const created = await client.createPayment({ ...card, source: "tok_pending" });
    await client.cancelPayment(created.id);

    const fetched = await client.getPayment(created.id);

    expect(fetched.status).toBe("canceled");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    const error = await rejection(client.getPayment("pay_missing"));

    expect(error.status).toBe(404);
    expect(error.code).toBe("payment_not_found");
    expect(error.message).toBe("No payment with id pay_missing");
  });

  test("URL-encodes ids so a slash cannot change the route", async () => {
    const error = await rejection(client.getPayment("a/b"));

    expect(error.status).toBe(404);
    expect(error.code).toBe("payment_not_found");
    expect(error.message).toBe("No payment with id a/b");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment(card);

    const error = await rejection(badKeyClient.getPayment(created.id));

    expect(error.status).toBe(401);
    expect(error.code).toBe("unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when unfiltered", async () => {
    const a = await client.createPayment(card);
    const b = await client.createPayment({ ...card, source: "tok_pending" });

    const list = await client.listPayments();

    expect(list).toHaveLength(2);
    expect(list).toContainEqual(a);
    expect(list).toContainEqual(b);
  });

  test("returns every payment when the filter has no status", async () => {
    await client.createPayment(card);
    await client.createPayment({ ...card, source: "tok_pending" });

    expect(await client.listPayments({})).toHaveLength(2);
  });

  test("filters by status", async () => {
    const succeeded = await client.createPayment(card);
    const pending = await client.createPayment({ ...card, source: "tok_pending" });

    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
  });

  test("returns an empty array when no payment matches the status", async () => {
    await client.createPayment(card);

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("reflects status changes in filtered results", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id, { amount: 400 });

    expect(await client.listPayments({ status: "succeeded" })).toEqual([]);
    const partial = await client.listPayments({ status: "partially_refunded" });
    expect(partial.map((p) => p.id)).toEqual([created.id]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const error = await rejection(badKeyClient.listPayments());

    expect(error.status).toBe(401);
    expect(error.code).toBe("unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await client.createPayment(card);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
  });

  test("fully refunds when the amount equals the payment amount", async () => {
    const created = await client.createPayment(card);

    const refunded = await client.refundPayment(created.id, { amount: 1000 });

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("partially refunds when the amount is smaller", async () => {
    const created = await client.createPayment(card);

    const refunded = await client.refundPayment(created.id, { amount: 300 });

    expect(refunded).toEqual({ ...created, status: "partially_refunded", amountRefunded: 300 });
  });

  test("accumulates partial refunds until the payment is fully refunded", async () => {
    const created = await client.createPayment(card);

    const first = await client.refundPayment(created.id, { amount: 300 });
    const second = await client.refundPayment(created.id, { amount: 200 });
    const rest = await client.refundPayment(created.id);

    expect(first.amountRefunded).toBe(300);
    expect(second.amountRefunded).toBe(500);
    expect(second.status).toBe("partially_refunded");
    expect(rest.amountRefunded).toBe(1000);
    expect(rest.status).toBe("refunded");
  });

  test("persists the refund so getPayment sees it", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id, { amount: 250 });

    const fetched = await client.getPayment(created.id);

    expect(fetched.amountRefunded).toBe(250);
    expect(fetched.status).toBe("partially_refunded");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    const error = await rejection(client.refundPayment("pay_missing"));

    expect(error.status).toBe(404);
    expect(error.code).toBe("payment_not_found");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment(card);

    const error = await rejection(badKeyClient.refundPayment(created.id));

    expect(error.status).toBe(401);
    expect(error.code).toBe("unauthorized");
  });

  test("rejects refunding a fully refunded payment with 409 already_refunded", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id);

    const error = await rejection(client.refundPayment(created.id));

    expect(error.status).toBe(409);
    expect(error.code).toBe("already_refunded");
    expect(error.message).toBe("Payment already refunded");
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await client.createPayment({ ...card, source: "tok_pending" });

    const error = await rejection(client.refundPayment(created.id));

    expect(error.status).toBe(409);
    expect(error.code).toBe("not_refundable");
    expect(error.message).toBe("A pending payment cannot be refunded");
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await client.createPayment({ ...card, source: "tok_pending" });
    await client.cancelPayment(created.id);

    const error = await rejection(client.refundPayment(created.id));

    expect(error.status).toBe(409);
    expect(error.code).toBe("not_refundable");
  });

  test.each([
    ["more than the payment amount", 1001],
    ["zero", 0],
    ["negative", -1],
    ["fractional", 10.5],
  ])("rejects a refund amount of %s with 422 invalid_refund_amount", async (_name, amount) => {
    const created = await client.createPayment(card);

    const error = await rejection(client.refundPayment(created.id, { amount }));

    expect(error.status).toBe(422);
    expect(error.code).toBe("invalid_refund_amount");
    expect(error.message).toBe("Refund amount must be between 1 and 1000");
  });

  test("rejects a refund larger than the remaining balance with 422", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id, { amount: 700 });

    const error = await rejection(client.refundPayment(created.id, { amount: 400 }));

    expect(error.status).toBe(422);
    expect(error.code).toBe("invalid_refund_amount");
    expect(error.message).toBe("Refund amount must be between 1 and 300");
  });

  test("leaves the payment untouched after a rejected refund", async () => {
    const created = await client.createPayment(card);
    await rejection(client.refundPayment(created.id, { amount: 5000 }));

    expect(await client.getPayment(created.id)).toEqual(created);
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment({ ...card, source: "tok_pending" });

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toEqual({ ...created, status: "canceled" });
  });

  test("persists the cancellation so getPayment sees it", async () => {
    const created = await client.createPayment({ ...card, source: "tok_pending" });
    await client.cancelPayment(created.id);

    expect((await client.getPayment(created.id)).status).toBe("canceled");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    const error = await rejection(client.cancelPayment("pay_missing"));

    expect(error.status).toBe(404);
    expect(error.code).toBe("payment_not_found");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment({ ...card, source: "tok_pending" });

    const error = await rejection(badKeyClient.cancelPayment(created.id));

    expect(error.status).toBe(401);
    expect(error.code).toBe("unauthorized");
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(card);

    const error = await rejection(client.cancelPayment(created.id));

    expect(error.status).toBe(409);
    expect(error.code).toBe("not_cancelable");
    expect(error.message).toBe("A succeeded payment cannot be canceled");
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await client.createPayment({ ...card, source: "tok_pending" });
    await client.cancelPayment(created.id);

    const error = await rejection(client.cancelPayment(created.id));

    expect(error.status).toBe(409);
    expect(error.code).toBe("not_cancelable");
    expect(error.message).toBe("A canceled payment cannot be canceled");
  });

  test("rejects canceling a refunded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id);

    const error = await rejection(client.cancelPayment(created.id));

    expect(error.status).toBe(409);
    expect(error.code).toBe("not_cancelable");
  });
});

describe("error body handling", () => {
  test("falls back to unknown_error and the status text for a non-JSON error body", async () => {
    server.use(
      http.get(
        "https://api.example.com/v1/payments/:id",
        () => new HttpResponse("upstream down", { status: 503, statusText: "Service Unavailable" }),
      ),
    );

    const error = await rejection(client.getPayment("pay_any"));

    expect(error.status).toBe(503);
    expect(error.code).toBe("unknown_error");
    expect(error.message).toBe("Service Unavailable");
  });

  test("falls back to unknown_error when the JSON body has no error object", async () => {
    server.use(
      http.get("https://api.example.com/v1/payments/:id", () =>
        HttpResponse.json({ oops: true }, { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    const error = await rejection(client.getPayment("pay_any"));

    expect(error.status).toBe(502);
    expect(error.code).toBe("unknown_error");
    expect(error.message).toBe("Bad Gateway");
  });
});
