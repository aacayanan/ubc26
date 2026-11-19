import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { InternalError, NotFoundError } from "@/lib/server/errors/app-error";
import {
  getActiveLineup,
  getLineupModel,
} from "@/lib/server/services/llm/models";

interface StubQuery {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  then: (resolve: (value: unknown) => void) => void;
}

function stubClient(result: { data: unknown; error: unknown }): {
  client: SupabaseClient;
  from: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
} {
  const query: StubQuery = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    order: vi.fn(() => query),
    maybeSingle: vi.fn(async () => result),
    // Awaiting the builder resolves to the result (Supabase's thenable shape).
    then: (resolve) => resolve(result),
  };
  const from = vi.fn(() => query);
  return {
    client: { from } as unknown as SupabaseClient,
    from,
    select: query.select,
  };
}

const ROW = {
  id: "uuid-1",
  slug: "cheapest-3-a",
  name: "Model A",
  provider: "openrouter",
  openrouter_model_id: "test/model-a",
  config: { temperature: 0 },
  sort_order: 1,
};

describe("getActiveLineup", () => {
  it("maps rows to records and asks for active models in sort order", async () => {
    const { client, from } = stubClient({ data: [ROW], error: null });

    const lineup = await getActiveLineup(client);

    expect(from).toHaveBeenCalledWith("llm_models");
    expect(lineup).toEqual([
      {
        id: "uuid-1",
        slug: "cheapest-3-a",
        name: "Model A",
        provider: "openrouter",
        openrouterModelId: "test/model-a",
        config: { temperature: 0 },
        sortOrder: 1,
      },
    ]);
  });

  it("coerces a non-object config to {}", async () => {
    const { client } = stubClient({
      data: [{ ...ROW, config: null }],
      error: null,
    });
    const [model] = await getActiveLineup(client);
    expect(model.config).toEqual({});
  });

  it("throws InternalError on a query error", async () => {
    const { client } = stubClient({ data: null, error: { message: "boom" } });
    await expect(getActiveLineup(client)).rejects.toBeInstanceOf(InternalError);
  });
});

describe("getLineupModel", () => {
  it("throws NotFoundError for a missing slug", async () => {
    const { client } = stubClient({ data: null, error: null });
    await expect(getLineupModel("nope", client)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
