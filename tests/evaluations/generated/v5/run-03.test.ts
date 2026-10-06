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

async function expectApiError(
  promise: Promise<unknown>,
  expected: { status: number; code: string; message?: string },
) {
  const error = await promise.then(
    () => {
      throw new Error("Expected the request to reject with PaymentsApiError");
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

const newPayment = (source = "tok_visa", amount = 1000) =>
  client.createPayment({ amount, currency: "usd", source });

describe("createPayment", () => {
  test("creates a succeeded payment and returns the stored fields", async () => {
    const payment = await newPayment("tok_visa", 2500);

    expect(payment.id).toMatch(/^pay_/);
    expect(payment.amount).toBe(2500);
    expect(payment.currency).toBe("usd");
    expect(payment.source).toBe("tok_visa");
    expect(payment.status).toBe("succeeded");
    expect(payment.amountRefunded).toBe(0);
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await newPayment("tok_pending");
    expect(payment.status).toBe("pending");
  });

  test("sends the bearer token and JSON body", async () => {
    let captured: { auth: string | null; contentType: string | null; body: unknown } | undefined;
    server.use(
      http.post(`${BASE_URL}/payments`, async ({ request }) => {
        captured = {
          auth: request.headers.get("Authorization"),
          contentType: request.headers.get("Content-Type"),
          body: await request.json(),
        };
        return HttpResponse.json({}, { status: 201 });
      }),
    );

    await newPayment("tok_visa", 300);

    expect(captured).toEqual({
      auth: "Bearer test_key",
      contentType: "application/json",
      body: { amount: 300, currency: "usd", source: "tok_visa" },
    });
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(newPayment("tok_chargeDeclined"), {
      status: 402,
      code: "card_declined",
      message: "The card was declined",
    });
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(newPayment("tok_insufficientFunds"), {
      status: 402,
      code: "insufficient_funds",
      message: "The card has insufficient funds",
    });
  });

  test("rejects a processing failure with 500 processing_error", async () => {
    await expectApiError(newPayment("tok_serverError"), {
      status: 500,
      code: "processing_error",
    });
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(newPayment("tok_bogus"), {
      status: 400,
      code: "invalid_source",
    });
  });

  test.each([
    ["zero amount", 0],
    ["negative amount", -5],
    ["fractional amount", 10.5],
  ])("rejects a %s with 400 invalid_request", async (_label, amount) => {
    await expectApiError(newPayment("tok_visa", amount), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("does not persist a payment when creation fails", async () => {
    await newPayment("tok_chargeDeclined").catch(() => undefined);
    expect(await client.listPayments()).toEqual([]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const bad = new PaymentsClient({ apiKey: "wrong_key" });
    await expectApiError(bad.createPayment({ amount: 100, currency: "usd", source: "tok_visa" }), {
      status: 401,
      code: "unauthorized",
      message: "Missing or invalid API key",
    });
  });
});

describe("getPayment", () => {
  test("returns the payment that was created", async () => {
    const created = await newPayment("tok_visa", 4200);
    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.getPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await newPayment();
    const bad = new PaymentsClient({ apiKey: "wrong_key" });
    await expectApiError(bad.getPayment(created.id), { status: 401, code: "unauthorized" });
  });

  test("URL-encodes the id in the request path", async () => {
    let requestedUrl = "";
    server.use(
      http.get(`${BASE_URL}/payments/:id`, ({ request }) => {
        requestedUrl = request.url;
        return HttpResponse.json({});
      }),
    );

    await client.getPayment("a/b?c");

    expect(requestedUrl).toBe(`${BASE_URL}/payments/a%2Fb%3Fc`);
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const a = await newPayment("tok_visa");
    const b = await newPayment("tok_pending");

    const all = await client.listPayments();

    expect(all.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("filters by status", async () => {
    const succeeded = await newPayment("tok_visa");
    const pending = await newPayment("tok_pending");

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const bad = new PaymentsClient({ apiKey: "wrong_key" });
    await expectApiError(bad.listPayments(), { status: 401, code: "unauthorized" });
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await newPayment("tok_visa", 1000);

    const refunded = await client.refundPayment(created.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
    expect((await client.getPayment(created.id)).status).toBe("refunded");
  });

  test("partially refunds and tracks the cumulative amount", async () => {
    const created = await newPayment("tok_visa", 1000);

    const first = await client.refundPayment(created.id, { amount: 300 });
    expect(first.status).toBe("partially_refunded");
    expect(first.amountRefunded).toBe(300);

    const second = await client.refundPayment(created.id, { amount: 700 });
    expect(second.status).toBe("refunded");
    expect(second.amountRefunded).toBe(1000);
  });

  test("a full refund after a partial one refunds only the remainder", async () => {
    const created = await newPayment("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded.amountRefunded).toBe(1000);
    expect(refunded.status).toBe("refunded");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("rejects refunding an already refunded payment with 409 already_refunded", async () => {
    const created = await newPayment();
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "already_refunded",
      message: "Payment already refunded",
    });
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const pending = await newPayment("tok_pending");

    await expectApiError(client.refundPayment(pending.id), {
      status: 409,
      code: "not_refundable",
      message: "A pending payment cannot be refunded",
    });
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const pending = await newPayment("tok_pending");
    await client.cancelPayment(pending.id);

    await expectApiError(client.refundPayment(pending.id), {
      status: 409,
      code: "not_refundable",
      message: "A canceled payment cannot be refunded",
    });
  });

  test.each([
    ["exceeds the remaining balance", 1001],
    ["is zero", 0],
    ["is negative", -1],
    ["is fractional", 1.5],
  ])("rejects a refund amount that %s with 422 invalid_refund_amount", async (_label, amount) => {
    const created = await newPayment("tok_visa", 1000);

    await expectApiError(client.refundPayment(created.id, { amount }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 1000",
    });
  });

  test("rejects a refund larger than what remains after a partial refund", async () => {
    const created = await newPayment("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 600 });

    await expectApiError(client.refundPayment(created.id, { amount: 500 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 400",
    });
  });

  test("a rejected refund leaves the payment unchanged", async () => {
    const created = await newPayment("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 5000 }).catch(() => undefined);

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await newPayment();
    const bad = new PaymentsClient({ apiKey: "wrong_key" });
    await expectApiError(bad.refundPayment(created.id), { status: 401, code: "unauthorized" });
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const pending = await newPayment("tok_pending");

    const canceled = await client.cancelPayment(pending.id);

    expect(canceled.id).toBe(pending.id);
    expect(canceled.status).toBe("canceled");
    expect((await client.getPayment(pending.id)).status).toBe("canceled");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await newPayment("tok_visa");

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A succeeded payment cannot be canceled",
    });
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const pending = await newPayment("tok_pending");
    await client.cancelPayment(pending.id);

    await expectApiError(client.cancelPayment(pending.id), {
      status: 409,
      code: "not_cancelable",
      message: "A canceled payment cannot be canceled",
    });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const pending = await newPayment("tok_pending");
    const bad = new PaymentsClient({ apiKey: "wrong_key" });
    await expectApiError(bad.cancelPayment(pending.id), { status: 401, code: "unauthorized" });
  });
});

describe("error parsing", () => {
  test("falls back to unknown_error and the status text when the body is not JSON", async () => {
    server.use(
      http.get(
        `${BASE_URL}/payments/:id`,
        () => new HttpResponse("Bad Gateway", { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    await expectApiError(client.getPayment("pay_any"), {
      status: 502,
      code: "unknown_error",
      message: "Bad Gateway",
    });
  });

  test("uses the code and message from the error envelope", async () => {
    server.use(
      http.get(`${BASE_URL}/payments/:id`, () =>
        HttpResponse.json({ error: { code: "rate_limited", message: "Slow down" } }, { status: 429 }),
      ),
    );

    await expectApiError(client.getPayment("pay_any"), {
      status: 429,
      code: "rate_limited",
      message: "Slow down",
    });
  });
});
