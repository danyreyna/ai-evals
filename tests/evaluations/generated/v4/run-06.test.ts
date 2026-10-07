import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const BASE_URL = "https://api.example.com/v1";

const client = new PaymentsClient({ apiKey: "test_key" });

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

async function expectApiError(
  promise: Promise<unknown>,
  expected: { status: number; code: string; message?: string },
) {
  const error = await promise.then(
    () => {
      throw new Error("Expected the call to reject with PaymentsApiError");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PaymentsApiError);
  const apiError = error as PaymentsApiError;
  expect(apiError.status).toBe(expected.status);
  expect(apiError.code).toBe(expected.code);
  if (expected.message !== undefined) {
    expect(apiError.message).toBe(expected.message);
  }
}

const card = { amount: 1000, currency: "usd", source: "tok_visa" };

describe("createPayment", () => {
  test("creates a succeeded payment", async () => {
    const payment = await client.createPayment(card);

    expect(payment.id).toStartWith("pay_");
    expect(payment).toMatchObject({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await client.createPayment({ ...card, source: "tok_pending" });
    expect(payment.status).toBe("pending");
  });

  test("rejects a non-positive amount with 400 invalid_request", async () => {
    await expectApiError(client.createPayment({ ...card, amount: 0 }), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("rejects a non-integer amount with 400 invalid_request", async () => {
    await expectApiError(client.createPayment({ ...card, amount: 10.5 }), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(client.createPayment({ ...card, source: "tok_nope" }), {
      status: 400,
      code: "invalid_source",
      message: "Unknown payment source",
    });
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(client.createPayment({ ...card, source: "tok_chargeDeclined" }), {
      status: 402,
      code: "card_declined",
      message: "The card was declined",
    });
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(client.createPayment({ ...card, source: "tok_insufficientFunds" }), {
      status: 402,
      code: "insufficient_funds",
    });
  });

  test("surfaces a server failure as 500 processing_error", async () => {
    await expectApiError(client.createPayment({ ...card, source: "tok_serverError" }), {
      status: 500,
      code: "processing_error",
    });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const bad = new PaymentsClient({ apiKey: "wrong_key" });
    await expectApiError(bad.createPayment(card), {
      status: 401,
      code: "unauthorized",
      message: "Missing or invalid API key",
    });
  });
});

describe("getPayment", () => {
  test("returns a previously created payment", async () => {
    const created = await client.createPayment(card);
    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("returns 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.getPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("returns 401 unauthorized for an invalid API key", async () => {
    const bad = new PaymentsClient({ apiKey: "wrong_key" });
    await expectApiError(bad.getPayment("pay_any"), { status: 401, code: "unauthorized" });
  });

  test("url-encodes the id", async () => {
    await expectApiError(client.getPayment("a/b"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id a/b",
    });
  });
});

describe("listPayments", () => {
  test("returns an empty list when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns all payments", async () => {
    const a = await client.createPayment(card);
    const b = await client.createPayment({ ...card, source: "tok_pending" });

    const list = await client.listPayments();
    expect(list).toHaveLength(2);
    expect(list.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("filters by status", async () => {
    const succeeded = await client.createPayment(card);
    const pending = await client.createPayment({ ...card, source: "tok_pending" });

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("returns 401 unauthorized for an invalid API key", async () => {
    const bad = new PaymentsClient({ apiKey: "wrong_key" });
    await expectApiError(bad.listPayments(), { status: 401, code: "unauthorized" });
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await client.createPayment(card);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({ id: created.id, status: "refunded", amountRefunded: 1000 });
  });

  test("partially refunds and allows a second refund of the remainder", async () => {
    const created = await client.createPayment(card);

    const partial = await client.refundPayment(created.id, { amount: 400 });
    expect(partial).toMatchObject({ status: "partially_refunded", amountRefunded: 400 });

    const rest = await client.refundPayment(created.id, { amount: 600 });
    expect(rest).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("returns 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.refundPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("returns 409 already_refunded for a fully refunded payment", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "already_refunded",
      message: "Payment already refunded",
    });
  });

  test("returns 409 not_refundable for a pending payment", async () => {
    const pending = await client.createPayment({ ...card, source: "tok_pending" });

    await expectApiError(client.refundPayment(pending.id), {
      status: 409,
      code: "not_refundable",
      message: "A pending payment cannot be refunded",
    });
  });

  test("returns 409 not_refundable for a canceled payment", async () => {
    const pending = await client.createPayment({ ...card, source: "tok_pending" });
    await client.cancelPayment(pending.id);

    await expectApiError(client.refundPayment(pending.id), {
      status: 409,
      code: "not_refundable",
    });
  });

  test("returns 422 invalid_refund_amount when the amount exceeds the remainder", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id, { amount: 300 });

    await expectApiError(client.refundPayment(created.id, { amount: 701 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 700",
    });
  });

  test("returns 422 invalid_refund_amount for a zero amount", async () => {
    const created = await client.createPayment(card);

    await expectApiError(client.refundPayment(created.id, { amount: 0 }), {
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("returns 422 invalid_refund_amount for a non-integer amount", async () => {
    const created = await client.createPayment(card);

    await expectApiError(client.refundPayment(created.id, { amount: 1.5 }), {
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("returns 401 unauthorized for an invalid API key", async () => {
    const bad = new PaymentsClient({ apiKey: "wrong_key" });
    await expectApiError(bad.refundPayment("pay_any"), { status: 401, code: "unauthorized" });
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const pending = await client.createPayment({ ...card, source: "tok_pending" });

    const canceled = await client.cancelPayment(pending.id);

    expect(canceled).toMatchObject({ id: pending.id, status: "canceled" });
    expect((await client.getPayment(pending.id)).status).toBe("canceled");
  });

  test("returns 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("returns 409 not_cancelable for a succeeded payment", async () => {
    const created = await client.createPayment(card);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A succeeded payment cannot be canceled",
    });
  });

  test("returns 409 not_cancelable for an already canceled payment", async () => {
    const pending = await client.createPayment({ ...card, source: "tok_pending" });
    await client.cancelPayment(pending.id);

    await expectApiError(client.cancelPayment(pending.id), {
      status: 409,
      code: "not_cancelable",
    });
  });

  test("returns 401 unauthorized for an invalid API key", async () => {
    const bad = new PaymentsClient({ apiKey: "wrong_key" });
    await expectApiError(bad.cancelPayment("pay_any"), { status: 401, code: "unauthorized" });
  });
});

describe("error fallbacks", () => {
  test("uses unknown_error and the status text when the error body is not JSON", async () => {
    server.use(
      http.get(
        `${BASE_URL}/payments/:id`,
        () => new HttpResponse("Bad gateway", { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    await expectApiError(client.getPayment("pay_any"), {
      status: 502,
      code: "unknown_error",
      message: "Bad Gateway",
    });
  });
});

describe("request shape", () => {
  test("sends the bearer token and JSON body on create", async () => {
    let seen: { auth: string | null; contentType: string | null; body: unknown } | undefined;
    server.use(
      http.post(`${BASE_URL}/payments`, async ({ request }) => {
        seen = {
          auth: request.headers.get("Authorization"),
          contentType: request.headers.get("Content-Type"),
          body: await request.json(),
        };
        return HttpResponse.json({}, { status: 201 });
      }),
    );

    await client.createPayment(card);

    expect(seen).toEqual({
      auth: "Bearer test_key",
      contentType: "application/json",
      body: card,
    });
  });
});
