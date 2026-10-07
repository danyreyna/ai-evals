/* oxlint-disable typescript/await-thenable -- bun-types types `.rejects` as void but it returns a promise */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const BASE_URL = "https://api.example.com/v1";

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

const newPayment = (source = "tok_visa", amount = 1000) =>
  client.createPayment({ amount, currency: "usd", source });

async function expectApiError(promise: Promise<unknown>, status: number, code: string) {
  await expect(promise).rejects.toBeInstanceOf(PaymentsApiError);
  await expect(promise).rejects.toMatchObject({ name: "PaymentsApiError", status, code });
}

describe("createPayment", () => {
  test("returns a succeeded payment for tok_visa", async () => {
    const payment = await newPayment("tok_visa", 2500);

    expect(payment).toMatchObject({
      amount: 2500,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(payment.id).toStartWith("pay_");
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("returns a pending payment for tok_pending", async () => {
    const payment = await newPayment("tok_pending");

    expect(payment.status).toBe("pending");
    expect(payment.source).toBe("tok_pending");
  });

  test("assigns a distinct id to each payment", async () => {
    const [a, b] = await Promise.all([newPayment(), newPayment()]);

    expect(a.id).not.toBe(b.id);
  });

  test("throws 402 card_declined for a declined card", async () => {
    const promise = newPayment("tok_chargeDeclined");

    await expectApiError(promise, 402, "card_declined");
    await expect(promise).rejects.toMatchObject({ message: "The card was declined" });
  });

  test("throws 402 insufficient_funds", async () => {
    await expectApiError(newPayment("tok_insufficientFunds"), 402, "insufficient_funds");
  });

  test("throws 500 processing_error on a server error", async () => {
    await expectApiError(newPayment("tok_serverError"), 500, "processing_error");
  });

  test("throws 400 invalid_source for an unknown source", async () => {
    await expectApiError(newPayment("tok_bogus"), 400, "invalid_source");
  });

  test("throws 400 invalid_request for a zero amount", async () => {
    await expectApiError(newPayment("tok_visa", 0), 400, "invalid_request");
  });

  test("throws 400 invalid_request for a negative amount", async () => {
    await expectApiError(newPayment("tok_visa", -5), 400, "invalid_request");
  });

  test("throws 400 invalid_request for a non-integer amount", async () => {
    await expectApiError(newPayment("tok_visa", 10.5), 400, "invalid_request");
  });

  test("throws 400 invalid_request when currency is missing", async () => {
    const promise = client.createPayment({ amount: 100, source: "tok_visa" } as never);

    await expectApiError(promise, 400, "invalid_request");
  });

  test("does not store a payment that failed", async () => {
    await expectApiError(newPayment("tok_chargeDeclined"), 402, "card_declined");

    expect(await client.listPayments()).toEqual([]);
  });

  test("throws 401 unauthorized with a bad api key", async () => {
    const bad = new PaymentsClient({ apiKey: "wrong" });
    const promise = bad.createPayment({ amount: 100, currency: "usd", source: "tok_visa" });

    await expectApiError(promise, 401, "unauthorized");
  });
});

describe("getPayment", () => {
  test("returns the payment that was created", async () => {
    const created = await newPayment("tok_visa", 4200);

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("throws 404 payment_not_found for an unknown id", async () => {
    const promise = client.getPayment("pay_missing");

    await expectApiError(promise, 404, "payment_not_found");
    await expect(promise).rejects.toMatchObject({ message: "No payment with id pay_missing" });
  });

  test("url-encodes the id so a slash does not change the route", async () => {
    const promise = client.getPayment("a/b");

    await expectApiError(promise, 404, "payment_not_found");
    await expect(promise).rejects.toMatchObject({ message: "No payment with id a/b" });
  });

  test("throws 401 unauthorized with a bad api key", async () => {
    const created = await newPayment();
    const bad = new PaymentsClient({ apiKey: "wrong" });

    await expectApiError(bad.getPayment(created.id), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const a = await newPayment("tok_visa");
    const b = await newPayment("tok_pending");

    const list = await client.listPayments();

    expect(list).toHaveLength(2);
    expect(list).toContainEqual(a);
    expect(list).toContainEqual(b);
  });

  test("filters by status", async () => {
    await newPayment("tok_visa");
    const pending = await newPayment("tok_pending");

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await newPayment("tok_visa");

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("reflects status changes in the filtered list", async () => {
    const payment = await newPayment("tok_visa", 1000);
    await client.refundPayment(payment.id, { amount: 400 });

    const partial = await client.listPayments({ status: "partially_refunded" });
    const succeeded = await client.listPayments({ status: "succeeded" });

    expect(partial.map((p) => p.id)).toEqual([payment.id]);
    expect(succeeded).toEqual([]);
  });

  test("throws 401 unauthorized with a bad api key", async () => {
    const bad = new PaymentsClient({ apiKey: "wrong" });

    await expectApiError(bad.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("refunds the full amount by default", async () => {
    const payment = await newPayment("tok_visa", 1000);

    const refunded = await client.refundPayment(payment.id);

    expect(refunded).toMatchObject({
      id: payment.id,
      status: "refunded",
      amountRefunded: 1000,
    });
  });

  test("partially refunds when an amount is given", async () => {
    const payment = await newPayment("tok_visa", 1000);

    const refunded = await client.refundPayment(payment.id, { amount: 300 });

    expect(refunded).toMatchObject({
      id: payment.id,
      status: "partially_refunded",
      amountRefunded: 300,
    });
  });

  test("refunding the remainder after a partial refund completes it", async () => {
    const payment = await newPayment("tok_visa", 1000);
    await client.refundPayment(payment.id, { amount: 300 });

    const refunded = await client.refundPayment(payment.id);

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("persists the refund so getPayment sees it", async () => {
    const payment = await newPayment("tok_visa", 1000);
    const refunded = await client.refundPayment(payment.id, { amount: 250 });

    expect(await client.getPayment(payment.id)).toEqual(refunded);
  });

  test("throws 422 invalid_refund_amount when amount exceeds the payment", async () => {
    const payment = await newPayment("tok_visa", 1000);
    const promise = client.refundPayment(payment.id, { amount: 1001 });

    await expectApiError(promise, 422, "invalid_refund_amount");
    await expect(promise).rejects.toMatchObject({
      message: "Refund amount must be between 1 and 1000",
    });
  });

  test("throws 422 invalid_refund_amount when amount exceeds the remaining balance", async () => {
    const payment = await newPayment("tok_visa", 1000);
    await client.refundPayment(payment.id, { amount: 800 });
    const promise = client.refundPayment(payment.id, { amount: 300 });

    await expectApiError(promise, 422, "invalid_refund_amount");
    await expect(promise).rejects.toMatchObject({
      message: "Refund amount must be between 1 and 200",
    });
  });

  test("throws 422 invalid_refund_amount for a zero amount", async () => {
    const payment = await newPayment();

    await expectApiError(
      client.refundPayment(payment.id, { amount: 0 }),
      422,
      "invalid_refund_amount",
    );
  });

  test("throws 422 invalid_refund_amount for a non-integer amount", async () => {
    const payment = await newPayment();

    await expectApiError(
      client.refundPayment(payment.id, { amount: 1.5 }),
      422,
      "invalid_refund_amount",
    );
  });

  test("throws 409 already_refunded for a fully refunded payment", async () => {
    const payment = await newPayment();
    await client.refundPayment(payment.id);

    await expectApiError(client.refundPayment(payment.id), 409, "already_refunded");
  });

  test("throws 409 not_refundable for a pending payment", async () => {
    const payment = await newPayment("tok_pending");
    const promise = client.refundPayment(payment.id);

    await expectApiError(promise, 409, "not_refundable");
    await expect(promise).rejects.toMatchObject({
      message: "A pending payment cannot be refunded",
    });
  });

  test("throws 409 not_refundable for a canceled payment", async () => {
    const payment = await newPayment("tok_pending");
    await client.cancelPayment(payment.id);

    await expectApiError(client.refundPayment(payment.id), 409, "not_refundable");
  });

  test("throws 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("throws 401 unauthorized with a bad api key", async () => {
    const payment = await newPayment();
    const bad = new PaymentsClient({ apiKey: "wrong" });

    await expectApiError(bad.refundPayment(payment.id), 401, "unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const payment = await newPayment("tok_pending");

    const canceled = await client.cancelPayment(payment.id);

    expect(canceled).toMatchObject({ id: payment.id, status: "canceled", amountRefunded: 0 });
  });

  test("persists the cancellation so getPayment sees it", async () => {
    const payment = await newPayment("tok_pending");
    const canceled = await client.cancelPayment(payment.id);

    expect(await client.getPayment(payment.id)).toEqual(canceled);
  });

  test("throws 409 not_cancelable for a succeeded payment", async () => {
    const payment = await newPayment("tok_visa");
    const promise = client.cancelPayment(payment.id);

    await expectApiError(promise, 409, "not_cancelable");
    await expect(promise).rejects.toMatchObject({
      message: "A succeeded payment cannot be canceled",
    });
  });

  test("throws 409 not_cancelable for an already canceled payment", async () => {
    const payment = await newPayment("tok_pending");
    await client.cancelPayment(payment.id);

    await expectApiError(client.cancelPayment(payment.id), 409, "not_cancelable");
  });

  test("throws 409 not_cancelable for a refunded payment", async () => {
    const payment = await newPayment("tok_visa");
    await client.refundPayment(payment.id);

    await expectApiError(client.cancelPayment(payment.id), 409, "not_cancelable");
  });

  test("throws 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("throws 401 unauthorized with a bad api key", async () => {
    const payment = await newPayment("tok_pending");
    const bad = new PaymentsClient({ apiKey: "wrong" });

    await expectApiError(bad.cancelPayment(payment.id), 401, "unauthorized");
  });
});

describe("request handling", () => {
  test("falls back to unknown_error when the error body is not JSON", async () => {
    server.use(
      http.get(
        `${BASE_URL}/payments/:id`,
        () => new HttpResponse("upstream down", { status: 502 }),
      ),
    );

    await expectApiError(client.getPayment("pay_any"), 502, "unknown_error");
  });

  test("sends requests to a custom baseUrl", async () => {
    server.use(
      http.get("https://custom.example.com/payments", () => HttpResponse.json({ data: [] })),
    );
    const custom = new PaymentsClient({
      apiKey: "anything",
      baseUrl: "https://custom.example.com",
    });

    expect(await custom.listPayments()).toEqual([]);
  });
});
