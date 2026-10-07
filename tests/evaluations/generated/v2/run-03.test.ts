import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
  resetPayments();
});
afterAll(() => {
  server.close();
});

const client = new PaymentsClient({ apiKey: "test_key" });

const validInput = { amount: 5000, currency: "usd", source: "tok_visa" };

async function expectApiError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(
    () => {
      throw new Error("expected the request to be rejected");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PaymentsApiError);
  expect(error).toMatchObject({ name: "PaymentsApiError", status, code });
  expect((error as PaymentsApiError).message.length).toBeGreaterThan(0);
}

describe("createPayment", () => {
  test("creates a succeeded payment", async () => {
    const payment = await client.createPayment(validInput);

    expect(payment).toMatchObject({
      amount: 5000,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(payment.id).toStartWith("pay_");
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await client.createPayment({ ...validInput, source: "tok_pending" });

    expect(payment.status).toBe("pending");
  });

  test("rejects an invalid API key with 401", async () => {
    const bad = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(bad.createPayment(validInput), 401, "unauthorized");
  });

  test("rejects a non-positive amount with 400", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, amount: 0 }),
      400,
      "invalid_request",
    );
  });

  test("rejects a non-integer amount with 400", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, amount: 10.5 }),
      400,
      "invalid_request",
    );
  });

  test("rejects an unknown source with 400", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, source: "tok_unknown" }),
      400,
      "invalid_source",
    );
  });

  test("surfaces a declined card as 402", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, source: "tok_chargeDeclined" }),
      402,
      "card_declined",
    );
  });

  test("surfaces insufficient funds as 402", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, source: "tok_insufficientFunds" }),
      402,
      "insufficient_funds",
    );
  });

  test("surfaces a processing failure as 500", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, source: "tok_serverError" }),
      500,
      "processing_error",
    );
  });
});

describe("getPayment", () => {
  test("returns a created payment", async () => {
    const created = await client.createPayment(validInput);

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an invalid API key with 401", async () => {
    const created = await client.createPayment(validInput);
    const bad = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(bad.getPayment(created.id), 401, "unauthorized");
  });

  test("rejects an unknown id with 404", async () => {
    await expectApiError(client.getPayment("pay_missing"), 404, "payment_not_found");
  });

  test("url-encodes the id", async () => {
    let path = "";
    server.use(
      http.get("https://api.example.com/v1/payments/:id", ({ request }) => {
        path = new URL(request.url).pathname;
        return HttpResponse.json({ id: "a/b" });
      }),
    );

    await client.getPayment("a/b");

    expect(path).toBe("/v1/payments/a%2Fb");
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment without a filter", async () => {
    const a = await client.createPayment(validInput);
    const b = await client.createPayment({ ...validInput, source: "tok_pending" });

    const list = await client.listPayments();

    expect(list.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("filters by status", async () => {
    await client.createPayment(validInput);
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });

    const list = await client.listPayments({ status: "pending" });

    expect(list).toEqual([pending]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await client.createPayment(validInput);

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("rejects an invalid API key with 401", async () => {
    const bad = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(bad.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await client.createPayment(validInput);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({ id: created.id, status: "refunded", amountRefunded: 5000 });
  });

  test("partially refunds when an amount is given", async () => {
    const created = await client.createPayment(validInput);

    const refunded = await client.refundPayment(created.id, { amount: 2000 });

    expect(refunded).toMatchObject({ status: "partially_refunded", amountRefunded: 2000 });
  });

  test("allows a second refund that completes a partially refunded payment", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id, { amount: 2000 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 5000 });
  });

  test("rejects an invalid API key with 401", async () => {
    const created = await client.createPayment(validInput);
    const bad = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(bad.refundPayment(created.id), 401, "unauthorized");
  });

  test("rejects an unknown id with 404", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects a second full refund with 409", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), 409, "already_refunded");
  });

  test("rejects refunding a pending payment with 409", async () => {
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });

    await expectApiError(client.refundPayment(pending.id), 409, "not_refundable");
  });

  test("rejects refunding a canceled payment with 409", async () => {
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(pending.id);

    await expectApiError(client.refundPayment(pending.id), 409, "not_refundable");
  });

  test("rejects a refund above the remaining amount with 422", async () => {
    const created = await client.createPayment(validInput);

    await expectApiError(
      client.refundPayment(created.id, { amount: 5001 }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects a refund above what is left after a partial refund with 422", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id, { amount: 4000 });

    await expectApiError(
      client.refundPayment(created.id, { amount: 1001 }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects a non-positive refund amount with 422", async () => {
    const created = await client.createPayment(validInput);

    await expectApiError(
      client.refundPayment(created.id, { amount: 0 }),
      422,
      "invalid_refund_amount",
    );
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });

    const canceled = await client.cancelPayment(pending.id);

    expect(canceled).toMatchObject({ id: pending.id, status: "canceled" });
    expect((await client.getPayment(pending.id)).status).toBe("canceled");
  });

  test("rejects an invalid API key with 401", async () => {
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });
    const bad = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(bad.cancelPayment(pending.id), 401, "unauthorized");
  });

  test("rejects an unknown id with 404", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects canceling a succeeded payment with 409", async () => {
    const created = await client.createPayment(validInput);

    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });

  test("rejects canceling an already canceled payment with 409", async () => {
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(pending.id);

    await expectApiError(client.cancelPayment(pending.id), 409, "not_cancelable");
  });
});

describe("error fallbacks", () => {
  test("uses unknown_error and the status text when the error body is not JSON", async () => {
    server.use(
      http.get(
        "https://api.example.com/v1/payments/pay_broken",
        () => new HttpResponse("upstream failure", { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    const error = await client.getPayment("pay_broken").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PaymentsApiError);
    expect(error).toMatchObject({ status: 502, code: "unknown_error", message: "Bad Gateway" });
  });
});

describe("request shape", () => {
  test("sends the bearer token and a JSON body on create", async () => {
    let seen: Request | undefined;
    server.use(
      http.post("https://api.example.com/v1/payments", async ({ request }) => {
        seen = request.clone();
        return HttpResponse.json({}, { status: 201 });
      }),
    );

    await client.createPayment(validInput);

    expect(seen?.headers.get("Authorization")).toBe("Bearer test_key");
    expect(seen?.headers.get("Content-Type")).toBe("application/json");
    expect(await seen?.json()).toEqual(validInput);
  });

  test("honors a custom baseUrl", async () => {
    server.use(
      http.get("https://payments.internal/v2/payments/pay_1", () =>
        HttpResponse.json({ id: "pay_1" }),
      ),
    );
    const custom = new PaymentsClient({ apiKey: "k", baseUrl: "https://payments.internal/v2" });

    expect(await custom.getPayment("pay_1")).toEqual({ id: "pay_1" } as never);
  });
});
