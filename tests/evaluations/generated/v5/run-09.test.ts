import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PaymentsApiError, PaymentsClient, type Payment } from "./index.ts";
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

async function expectApiError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PaymentsApiError);
  const apiError = error as PaymentsApiError;
  expect(apiError.status).toBe(status);
  expect(apiError.code).toBe(code);
  return apiError;
}

const create = (source = "tok_visa", amount = 1000) =>
  client.createPayment({ amount, currency: "usd", source });

describe("createPayment", () => {
  test("creates a succeeded payment for tok_visa", async () => {
    const payment = await create("tok_visa", 2500);
    expect(payment.id).toStartWith("pay_");
    expect(payment.amount).toBe(2500);
    expect(payment.currency).toBe("usd");
    expect(payment.source).toBe("tok_visa");
    expect(payment.status).toBe("succeeded");
    expect(payment.amountRefunded).toBe(0);
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await create("tok_pending");
    expect(payment.status).toBe("pending");
  });

  test("rejects a declined card with 402 card_declined", async () => {
    const error = await expectApiError(create("tok_chargeDeclined"), 402, "card_declined");
    expect(error.message).toBe("The card was declined");
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    const error = await expectApiError(create("tok_insufficientFunds"), 402, "insufficient_funds");
    expect(error.message).toBe("The card has insufficient funds");
  });

  test("surfaces a processing failure as 500 processing_error", async () => {
    await expectApiError(create("tok_serverError"), 500, "processing_error");
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(create("tok_bogus"), 400, "invalid_source");
  });

  test.each([0, -5, 10.5])("rejects amount %p with 400 invalid_request", async (amount) => {
    await expectApiError(create("tok_visa", amount), 400, "invalid_request");
  });

  test("rejects a missing currency with 400 invalid_request", async () => {
    const input = { amount: 100, source: "tok_visa" } as unknown as Parameters<
      typeof client.createPayment
    >[0];
    await expectApiError(client.createPayment(input), 400, "invalid_request");
  });

  test("does not persist a payment that failed", async () => {
    await expectApiError(create("tok_chargeDeclined"), 402, "card_declined");
    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns the payment that was created", async () => {
    const created = await create("tok_visa", 700);
    const fetched = await client.getPayment(created.id);
    expect(fetched).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    const error = await expectApiError(client.getPayment("pay_missing"), 404, "payment_not_found");
    expect(error.message).toBe("No payment with id pay_missing");
  });

  test("url-encodes the id so a slash cannot reach another route", async () => {
    const created = await create();
    await expectApiError(client.getPayment(`${created.id}/refund`), 404, "payment_not_found");
    expect((await client.getPayment(created.id)).amountRefunded).toBe(0);
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const a = await create("tok_visa");
    const b = await create("tok_pending");
    const list = await client.listPayments();
    expect(list.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("filters by status", async () => {
    const succeeded = await create("tok_visa");
    const pending = await create("tok_pending");

    const onlyPending = await client.listPayments({ status: "pending" });
    expect(onlyPending.map((p) => p.id)).toEqual([pending.id]);

    const onlySucceeded = await client.listPayments({ status: "succeeded" });
    expect(onlySucceeded.map((p) => p.id)).toEqual([succeeded.id]);

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await create("tok_visa", 1000);
    const refunded = await client.refundPayment(created.id);
    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
    expect((await client.getPayment(created.id)).status).toBe("refunded");
  });

  test("partially refunds when an amount is given", async () => {
    const created = await create("tok_visa", 1000);
    const refunded = await client.refundPayment(created.id, { amount: 400 });
    expect(refunded.status).toBe("partially_refunded");
    expect(refunded.amountRefunded).toBe(400);
  });

  test("refunds the remainder after a partial refund", async () => {
    const created = await create("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 400 });
    const refunded = await client.refundPayment(created.id);
    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("rejects a refund larger than the remaining amount with 422", async () => {
    const created = await create("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 400 });
    const error = await expectApiError(
      client.refundPayment(created.id, { amount: 601 }),
      422,
      "invalid_refund_amount",
    );
    expect(error.message).toBe("Refund amount must be between 1 and 600");
    expect((await client.getPayment(created.id)).amountRefunded).toBe(400);
  });

  test.each([0, -1, 2.5])("rejects refund amount %p with 422", async (amount) => {
    const created = await create();
    await expectApiError(
      client.refundPayment(created.id, { amount }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects refunding a fully refunded payment with 409 already_refunded", async () => {
    const created = await create();
    await client.refundPayment(created.id);
    await expectApiError(client.refundPayment(created.id), 409, "already_refunded");
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await create("tok_pending");
    const error = await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
    expect(error.message).toBe("A pending payment cannot be refunded");
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await create("tok_pending");
    await client.cancelPayment(created.id);
    await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await create("tok_pending");
    const canceled = await client.cancelPayment(created.id);
    expect(canceled.id).toBe(created.id);
    expect(canceled.status).toBe("canceled");
    expect((await client.getPayment(created.id)).status).toBe("canceled");
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await create("tok_visa");
    const error = await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
    expect(error.message).toBe("A succeeded payment cannot be canceled");
  });

  test("rejects canceling twice with 409 not_cancelable", async () => {
    const created = await create("tok_pending");
    await client.cancelPayment(created.id);
    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });
});

describe("authentication", () => {
  const bad = new PaymentsClient({ apiKey: "wrong_key" });

  test("every method rejects an invalid key with 401 unauthorized", async () => {
    const created: Payment = await create("tok_pending");
    const calls = [
      bad.createPayment({ amount: 100, currency: "usd", source: "tok_visa" }),
      bad.getPayment(created.id),
      bad.listPayments(),
      bad.refundPayment(created.id),
      bad.cancelPayment(created.id),
    ];
    for (const call of calls) {
      const error = await expectApiError(call, 401, "unauthorized");
      expect(error.message).toBe("Missing or invalid API key");
    }
    expect((await client.getPayment(created.id)).status).toBe("pending");
  });
});

describe("error fallbacks", () => {
  test("uses unknown_error and statusText when the error body is not JSON", async () => {
    const { http, HttpResponse } = await import("msw");
    server.use(
      http.get(
        "https://api.example.com/v1/payments/pay_x",
        () => new HttpResponse("bad gateway", { status: 502, statusText: "Bad Gateway" }),
      ),
    );
    const error = await expectApiError(client.getPayment("pay_x"), 502, "unknown_error");
    expect(error.message).toBe("Bad Gateway");
  });

  test("honors a custom baseUrl", async () => {
    const { http, HttpResponse } = await import("msw");
    server.use(
      http.get("https://other.example.com/api/payments/pay_x", () =>
        HttpResponse.json({ error: { code: "custom", message: "custom host" } }, { status: 418 }),
      ),
    );
    const custom = new PaymentsClient({
      apiKey: "test_key",
      baseUrl: "https://other.example.com/api",
    });
    await expectApiError(custom.getPayment("pay_x"), 418, "custom");
  });
});
