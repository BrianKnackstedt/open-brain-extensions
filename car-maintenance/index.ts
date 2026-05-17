/// <reference types="@supabase/functions-js/edge-runtime.d.ts" />

import { type Context, Hono } from "hono";
import { StreamableHTTPTransport } from "@hono/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

const app = new Hono();
const SERVICE_NAME = "Car Maintenance Tracker";
const SERVICE_VERSION = "1.0.0";
const SAMPLE_SEED_SOURCE = "sample-vehicle-seed";

const prioritySchema = z.enum(["low", "medium", "high", "urgent"]);
const taskStatusSchema = z.enum(["active", "paused", "completed", "archived"]);
const timelineStatusSchema = z.enum([
  "pending",
  "completed",
  "skipped",
  "archived",
]);
const timelineTypeSchema = z.enum([
  "projected",
  "one_time",
  "dealer_reference",
  "seasonal",
  "watch",
]);
const watchStatusSchema = z.enum(["active", "resolved", "archived"]);
const checklistTypeSchema = z.enum([
  "yearly",
  "pre_winter",
  "highway_trip",
  "custom",
]);

function textResult(payload: unknown, isError = false) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify(payload, null, 2),
    }],
    ...(isError ? { isError: true } : {}),
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return textResult({ success: false, error: message }, true);
}

function stripUndefined(input: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}

function estimateDateForMileage(
  targetMileage: number,
  baseMileage = 49010,
  baseDate = "2026-05-10",
  annualMiles = 13500,
) {
  const base = new Date(`${baseDate}T12:00:00Z`);
  const deltaMiles = targetMileage - baseMileage;
  const deltaDays = Math.round((deltaMiles / annualMiles) * 365.25);
  base.setUTCDate(base.getUTCDate() + deltaDays);
  return base.toISOString().slice(0, 10);
}

function estimateMileageForDate(
  targetDate: string,
  baseMileage = 49010,
  baseDate = "2026-05-10",
  annualMiles = 13500,
) {
  const start = new Date(`${baseDate}T12:00:00Z`);
  const end = new Date(
    targetDate.includes("T") ? targetDate : `${targetDate}T12:00:00Z`,
  );
  const daysDelta = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
  const milesDelta = Math.round((daysDelta / 365.25) * annualMiles);
  return baseMileage + milesDelta;
}

function asTimestamp(date: string) {
  if (date.includes("T")) {
    return date;
  }
  return `${date}T12:00:00Z`;
}

function normalizeOptionalDateInput(date?: string) {
  if (!date) {
    return undefined;
  }

  const normalized = date.trim();
  if (!normalized) {
    return undefined;
  }

  const lower = normalized.toLowerCase();
  if (lower === "unknown" || lower === "n/a" || lower === "na") {
    return undefined;
  }

  return normalized;
}

function normalizeOptionalDateOnlyInput(date?: string) {
  const normalized = normalizeOptionalDateInput(date);
  return normalized ? normalized.slice(0, 10) : undefined;
}

function normalizeStringForKey(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSeasonalMonths(value: unknown) {
  return Array.isArray(value)
    ? value.filter((month): month is number => typeof month === "number")
    : [];
}

function dateMatchesSeason(
  date: Date | string | null | undefined,
  seasonalMonths: number[],
) {
  if (seasonalMonths.length === 0) {
    return true;
  }
  if (!date) {
    return false;
  }

  const parsedDate = date instanceof Date
    ? date
    : new Date(date.includes("T") ? date : `${date}T12:00:00Z`);
  if (Number.isNaN(parsedDate.getTime())) {
    return false;
  }

  return seasonalMonths.includes(parsedDate.getUTCMonth() + 1);
}

function isSeasonRelevant(
  date: Date | string | null | undefined,
  seasonalMonths: number[],
  currentMonth?: number,
) {
  return seasonalMonths.length === 0 ||
    (typeof currentMonth === "number" &&
      seasonalMonths.includes(currentMonth)) ||
    dateMatchesSeason(date, seasonalMonths);
}

function normalizeWatchKey(value: string) {
  return value.toLowerCase().replaceAll("_", " ").replaceAll("-", " ")
    .replace(/\s+/g, " ").trim();
}

function humanizeWatchTag(value: string) {
  return normalizeWatchKey(value).replace(/\b\w/g, (match) =>
    match.toUpperCase()
  );
}

const defaultWatchItemDetails: Record<
  string,
  {
    topic: string;
    priority: "low" | "medium" | "high" | "urgent";
    symptoms: string;
    monitoring_notes: string;
    action_threshold: string;
  }
> = {
  "carbon buildup": {
    topic: "Carbon buildup",
    priority: "medium",
    symptoms:
      "Rough idle, misfires, hesitation, poor fuel economy, or check-engine codes.",
    monitoring_notes:
      "Monitor symptoms before approving induction service. Fuel cleaners can help fuel-system deposits but do not fully remove intake valve deposits on direct-injection engines.",
    action_threshold:
      "Consider diagnostic inspection or induction cleaning only when symptoms, codes, or manual guidance support it.",
  },
  "turbo oil health": {
    topic: "Turbo oil health",
    priority: "high",
    symptoms:
      "Oil consumption, smoke, turbo noise, delayed oil changes, or oil spec uncertainty.",
    monitoring_notes:
      "Maintain the vehicle's stored full-synthetic oil interval and track brand, viscosity, and specification.",
    action_threshold:
      "Investigate if oil level drops between changes, smoke appears, turbo noise develops, or oil changes are delayed.",
  },
  "battery aging": {
    topic: "Battery aging",
    priority: "medium",
    symptoms:
      "Slow crank, warning lights, low voltage, weak cold starts, or failed load test.",
    monitoring_notes:
      "Test before winter and record voltage, age, and cold-cranking performance.",
    action_threshold:
      "Replace based on failed test or weak winter starting behavior, not age alone.",
  },
  "tire wear": {
    topic: "Tire wear",
    priority: "high",
    symptoms:
      "Uneven tread wear, steering pull, vibration, pressure loss, or warranty documentation gaps.",
    monitoring_notes:
      "Protect the tire warranty with rotations, pressure logs, alignment, tread-depth records, and receipts.",
    action_threshold:
      "Check alignment after steering pull, uneven wear, off-center wheel, or pothole impact.",
  },
  "brake moisture contamination": {
    topic: "Brake moisture contamination",
    priority: "high",
    symptoms:
      "Dark fluid, soft pedal, corrosion, ABS/brake warnings, or long brake-fluid age.",
    monitoring_notes:
      "Brake fluid absorbs moisture; humidity and winter road treatment make corrosion prevention important.",
    action_threshold:
      "Exchange overdue brake fluid, then repeat on the stored mileage/time interval.",
  },
};

function sortWatchItems(watchItems: Record<string, unknown>[]) {
  const priorityOrder: Record<string, number> = {
    urgent: 0,
    high: 1,
    medium: 2,
    low: 3,
  };

  return [...watchItems].sort((left, right) => {
    const priorityDelta =
      (priorityOrder[String(left.priority)] ?? 99) -
      (priorityOrder[String(right.priority)] ?? 99);
    if (priorityDelta !== 0) return priorityDelta;
    return String(left.topic).localeCompare(String(right.topic));
  });
}

function buildDerivedWatchItemsFromTaskTags(
  userId: string,
  vehicleId: string,
  tasks: Record<string, unknown>[],
) {
  const taskNamesByWatchKey = new Map<
    string,
    { tag: string; taskNames: Set<string> }
  >();

  for (const task of tasks) {
    const taskName = typeof task.name === "string" ? task.name : undefined;
    const watchTags = Array.isArray(task.watch_tags)
      ? task.watch_tags.filter((tag): tag is string => typeof tag === "string")
      : [];

    for (const tag of watchTags) {
      const watchKey = normalizeWatchKey(tag);
      if (!watchKey) continue;

      const entry = taskNamesByWatchKey.get(watchKey) ?? {
        tag,
        taskNames: new Set<string>(),
      };
      if (taskName) {
        entry.taskNames.add(taskName);
      }
      taskNamesByWatchKey.set(watchKey, entry);
    }
  }

  return Array.from(taskNamesByWatchKey.entries()).map(
    ([watchKey, entry]) => {
      const defaultDetails = defaultWatchItemDetails[watchKey];
      const topic = defaultDetails?.topic ?? humanizeWatchTag(entry.tag);
      return stripUndefined({
        id: `derived:${vehicleId}:${watchKey.replace(/\s+/g, "-")}`,
        user_id: userId,
        vehicle_id: vehicleId,
        topic,
        priority: defaultDetails?.priority ?? "medium",
        symptoms: defaultDetails?.symptoms,
        monitoring_notes: defaultDetails?.monitoring_notes ??
          `Review related task notes for ${topic}.`,
        action_threshold: defaultDetails?.action_threshold ??
          "Take action when symptoms appear or related maintenance becomes due.",
        related_task_names: Array.from(entry.taskNames).sort(),
        status: "active",
        generated_from_task_watch_tags: true,
      });
    },
  );
}

function buildDefaultChecklistResults(
  userId: string,
  vehicleId: string,
  checklistType?: string,
) {
  return buildSampleChecklistSeeds(vehicleId)
    .filter((seed) =>
      !checklistType || seed.checklist.checklist_type === checklistType
    )
    .map((seed) => {
      const checklistTypeValue = String(seed.checklist.checklist_type);
      const checklistId = `default:${vehicleId}:${checklistTypeValue}`;
      return {
        id: checklistId,
        user_id: userId,
        ...seed.checklist,
        generated_from_default_template: true,
        items: seed.items.map((item, index) => ({
          id: `${checklistId}:${index + 1}`,
          user_id: userId,
          checklist_id: checklistId,
          default_checked: false,
          ...item,
          generated_from_default_template: true,
        })),
      };
    });
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSerialize(entryValue)}`);
    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(value);
}

function buildMaintenanceLogDedupeKey(seed: Record<string, unknown>) {
  const completedAt = normalizeOptionalDateInput(
    seed.completed_at as string | undefined,
  ) ?? "";
  const mileage = typeof seed.mileage === "number" ? seed.mileage : "";
  const taskId = typeof seed.task_id === "string" ? seed.task_id : "";
  const vendorName = normalizeStringForKey(seed.vendor_name);
  const performedBy = normalizeStringForKey(seed.performed_by);
  const source = normalizeStringForKey(seed.source);
  const serviceItems = stableSerialize(seed.service_items ?? []);
  const partsFluids = stableSerialize(seed.parts_fluids ?? {});

  return [
    completedAt,
    String(mileage),
    taskId,
    vendorName,
    performedBy,
    source,
    serviceItems,
    partsFluids,
  ].join("|");
}

function requireEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

async function inferTaskDueFields(
  supabase: SupabaseClient,
  vehicleId: string,
  values: {
    interval_miles?: number;
    interval_days?: number;
    last_completed_at?: string;
    last_completed_mileage?: number;
    next_due_at?: string;
    next_due_mileage?: number;
  },
) {
  let nextDueMileage = values.next_due_mileage;
  let nextDueAt = values.next_due_at;

  if (typeof nextDueMileage === "number" && nextDueAt) {
    return { nextDueMileage, nextDueAt };
  }

  const { data: vehicle, error } = await supabase
    .from("vehicles")
    .select("current_mileage, mileage_as_of, annual_miles_estimate")
    .eq("id", vehicleId)
    .single();

  if (error) {
    throw new Error(
      `Failed to load vehicle for due-field inference: ${error.message}`,
    );
  }

  if (
    typeof nextDueMileage !== "number" &&
    typeof values.interval_miles === "number" &&
    typeof values.last_completed_mileage === "number"
  ) {
    nextDueMileage = values.last_completed_mileage + values.interval_miles;
  }

  if (
    !nextDueAt && typeof values.interval_days === "number" &&
    values.last_completed_at
  ) {
    const dueAt = new Date(asTimestamp(values.last_completed_at));
    dueAt.setUTCDate(dueAt.getUTCDate() + values.interval_days);
    nextDueAt = dueAt.toISOString();
  }

  if (!nextDueAt && typeof nextDueMileage === "number") {
    const baseMileage = values.last_completed_mileage ??
      vehicle.current_mileage ?? 0;
    const baseDate = values.last_completed_at
      ? asTimestamp(values.last_completed_at).slice(0, 10)
      : (vehicle.mileage_as_of ?? new Date().toISOString().slice(0, 10));
    nextDueAt = asTimestamp(
      estimateDateForMileage(
        nextDueMileage,
        baseMileage,
        baseDate,
        vehicle.annual_miles_estimate ?? 13500,
      ),
    );
  }

  return { nextDueMileage, nextDueAt };
}

function patchAcceptHeaderIfNeeded(c: Context) {
  if (c.req.header("accept")?.includes("text/event-stream")) {
    return;
  }

  const headers = new Headers(c.req.raw.headers);
  headers.set("Accept", "application/json, text/event-stream");
  const patched = new Request(c.req.raw.url, {
    method: c.req.raw.method,
    headers,
    body: c.req.raw.body,
    // @ts-ignore Deno requires duplex for streaming request bodies.
    duplex: "half",
  });

  Object.defineProperty(c.req, "raw", { value: patched, writable: true });
}

function registerTools(
  server: McpServer,
  supabase: SupabaseClient,
  userId: string,
) {
  server.tool(
    "add_vehicle",
    "Create a vehicle record for maintenance tracking.",
    {
      name: z.string().describe(
        "Friendly vehicle name, such as '2022 midsize sedan'",
      ),
      year: z.number().int().optional().describe("Vehicle model year"),
      make: z.string().optional().describe("Vehicle make"),
      model: z.string().optional().describe("Vehicle model"),
      trim: z.string().optional().describe("Trim level"),
      engine: z.string().optional().describe(
        "Engine or drivetrain description",
      ),
      vin: z.string().optional().describe("VIN, if known"),
      license_plate: z.string().optional().describe(
        "License plate, if desired",
      ),
      current_mileage: z.number().int().nonnegative().optional().describe(
        "Current odometer mileage",
      ),
      mileage_as_of: z.string().optional().describe(
        "Date for current mileage, YYYY-MM-DD",
      ),
      annual_miles_min: z.number().int().nonnegative().optional().describe(
        "Low end annual mileage estimate",
      ),
      annual_miles_max: z.number().int().nonnegative().optional().describe(
        "High end annual mileage estimate",
      ),
      annual_miles_estimate: z.number().int().positive().optional().describe(
        "Planning midpoint for date projections",
      ),
      climate_notes: z.string().optional().describe(
        "Climate and corrosion conditions",
      ),
      driving_notes: z.string().optional().describe(
        "Driving style and road conditions",
      ),
      reliability_goal: z.string().optional().describe(
        "Owner reliability strategy",
      ),
      tire_installed_at_mileage: z.number().int().nonnegative().optional()
        .describe("Mileage when current tires were installed"),
      tire_warranty_miles: z.number().int().nonnegative().optional().describe(
        "Tire mileage warranty",
      ),
      tire_details: z.string().optional().describe(
        "Current tire model, size, warranty, and vendor notes",
      ),
      metadata: z.record(z.string(), z.unknown()).optional().describe(
        "Additional structured details",
      ),
    },
    async (args) => {
      try {
        const payload = stripUndefined({
          user_id: userId,
          name: args.name,
          year: args.year,
          make: args.make,
          model: args.model,
          trim: args.trim,
          engine: args.engine,
          vin: args.vin,
          license_plate: args.license_plate,
          current_mileage: args.current_mileage ?? 0,
          mileage_as_of: args.mileage_as_of,
          annual_miles_min: args.annual_miles_min,
          annual_miles_max: args.annual_miles_max,
          annual_miles_estimate: args.annual_miles_estimate,
          climate_notes: args.climate_notes,
          driving_notes: args.driving_notes,
          reliability_goal: args.reliability_goal,
          tire_installed_at_mileage: args.tire_installed_at_mileage,
          tire_warranty_miles: args.tire_warranty_miles,
          tire_details: args.tire_details,
          metadata: args.metadata ?? {},
        });

        const { data, error } = await supabase
          .from("vehicles")
          .insert(payload)
          .select("*")
          .single();

        if (error) {
          throw new Error(`Failed to add vehicle: ${error.message}`);
        }

        return textResult({
          success: true,
          message: `Added vehicle: ${args.name}`,
          vehicle: data,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "list_vehicles",
    "List stored vehicles and optionally filter by a partial vehicle search string.",
    {
      query: z.string().optional().describe(
        "Optional partial match across vehicle name, make, model, trim, or license plate",
      ),
      limit: z.number().int().positive().max(100).optional().describe(
        "Maximum number of vehicles to return, default 25",
      ),
    },
    async (args) => {
      try {
        const limit = args.limit ?? 25;
        let vehicleQuery = supabase
          .from("vehicles")
          .select("*")
          .eq("user_id", userId)
          .order("updated_at", { ascending: false })
          .limit(limit);

        if (args.query) {
          vehicleQuery = vehicleQuery.or(
            [
              `name.ilike.%${args.query}%`,
              `make.ilike.%${args.query}%`,
              `model.ilike.%${args.query}%`,
              `trim.ilike.%${args.query}%`,
              `license_plate.ilike.%${args.query}%`,
            ].join(","),
          );
        }

        const { data, error } = await vehicleQuery;
        if (error) {
          throw new Error(`Failed to list vehicles: ${error.message}`);
        }

        return textResult({
          success: true,
          count: data?.length ?? 0,
          vehicles: data ?? [],
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "update_vehicle_mileage",
    "Update a vehicle's current mileage and mileage date.",
    {
      vehicle_id: z.string().uuid().describe("Vehicle UUID"),
      current_mileage: z.number().int().nonnegative().describe(
        "Current odometer mileage",
      ),
      mileage_as_of: z.string().optional().describe(
        "Date for the mileage reading, YYYY-MM-DD",
      ),
      recalculate_due_dates: z.boolean().optional().describe(
        "Reserved for future recalculation behavior",
      ),
    },
    async (args) => {
      try {
        const { data, error } = await supabase
          .from("vehicles")
          .update(stripUndefined({
            current_mileage: args.current_mileage,
            mileage_as_of: args.mileage_as_of,
          }))
          .eq("id", args.vehicle_id)
          .eq("user_id", userId)
          .select("*")
          .single();

        if (error) {
          throw new Error(`Failed to update vehicle mileage: ${error.message}`);
        }

        return textResult({
          success: true,
          message: "Vehicle mileage updated",
          vehicle: data,
          recalculation_note: args.recalculate_due_dates
            ? "Existing task due estimates are preserved; log maintenance or edit tasks to recalculate exact due fields."
            : undefined,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "add_vehicle_timeline_item",
    "Create or update a vehicle timeline item such as a milestone, reminder, or watch entry.",
    {
      vehicle_id: z.string().uuid().describe("Vehicle UUID"),
      task_id: z.string().uuid().optional().describe(
        "Related maintenance task UUID",
      ),
      title: z.string().describe("Timeline title"),
      category: z.string().optional().describe("Timeline category"),
      item_type: timelineTypeSchema.optional().describe(
        "Timeline item type",
      ),
      target_mileage: z.number().int().nonnegative().optional().describe(
        "Target mileage for the item",
      ),
      target_date: z.string().optional().describe(
        "Target date, YYYY-MM-DD or timestamp",
      ),
      priority: prioritySchema.optional().describe("Priority level"),
      status: z.enum(["pending", "completed", "skipped", "archived"])
        .optional().describe("Timeline status"),
      notes: z.string().optional().describe("Timeline notes"),
    },
    async (args) => {
      try {
        const targetDate = normalizeOptionalDateInput(args.target_date);
        const item = await ensureTimelineItem(supabase, userId, args.vehicle_id, {
          task_id: args.task_id,
          title: args.title,
          category: args.category,
          item_type: args.item_type ?? "one_time",
          target_mileage: args.target_mileage,
          target_date: targetDate,
          priority: args.priority ?? "medium",
          status: args.status ?? "pending",
          notes: args.notes,
        });

        return textResult({
          success: true,
          message: `Stored vehicle timeline item: ${args.title}`,
          timeline_item: item,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "add_vehicle_watch_item",
    "Create or update a vehicle watch-list concern.",
    {
      vehicle_id: z.string().uuid().describe("Vehicle UUID"),
      topic: z.string().describe("Watch-list topic"),
      priority: prioritySchema.optional().describe("Priority level"),
      symptoms: z.string().optional().describe(
        "Symptoms or signs to monitor",
      ),
      monitoring_notes: z.string().optional().describe(
        "How to monitor the concern over time",
      ),
      action_threshold: z.string().optional().describe(
        "When to take action or approve service",
      ),
      related_task_names: z.array(z.string()).optional().describe(
        "Related maintenance task names",
      ),
      status: z.enum(["active", "resolved", "archived"]).optional()
        .describe("Watch-list status"),
    },
    async (args) => {
      try {
        const watchItem = await ensureWatchItem(
          supabase,
          userId,
          args.vehicle_id,
          {
            topic: args.topic,
            priority: args.priority ?? "medium",
            symptoms: args.symptoms,
            monitoring_notes: args.monitoring_notes,
            action_threshold: args.action_threshold,
            related_task_names: args.related_task_names,
            status: args.status ?? "active",
          },
        );

        return textResult({
          success: true,
          message: `Stored vehicle watch item: ${args.topic}`,
          watch_item: watchItem,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "add_vehicle_checklist",
    "Create or update a vehicle checklist and its ordered items.",
    {
      vehicle_id: z.string().uuid().describe("Vehicle UUID"),
      name: z.string().describe("Checklist name"),
      checklist_type: checklistTypeSchema.describe("Checklist type"),
      cadence_days: z.number().int().positive().optional().describe(
        "Optional checklist cadence in days",
      ),
      seasonal_months: z.array(z.number().int().min(1).max(12)).optional()
        .describe("Months when the checklist is most relevant"),
      notes: z.string().optional().describe("Checklist notes"),
      replace_existing_items: z.boolean().optional().describe(
        "Replace prior checklist items not present in this call",
      ),
      items: z.array(z.object({
        label: z.string().describe("Checklist item label"),
        category: z.string().optional().describe("Checklist item category"),
        priority: prioritySchema.optional().describe("Checklist item priority"),
        sort_order: z.number().int().optional().describe(
          "Display order for the item",
        ),
        notes: z.string().optional().describe("Checklist item notes"),
        default_checked: z.boolean().optional().describe(
          "Whether the item starts checked by default",
        ),
      })).describe("Ordered checklist items"),
    },
    async (args) => {
      try {
        const checklist = await ensureChecklist(
          supabase,
          userId,
          args.vehicle_id,
          {
            checklist: {
              name: args.name,
              checklist_type: args.checklist_type,
              cadence_days: args.cadence_days,
              seasonal_months: args.seasonal_months,
              notes: args.notes,
            },
            items: args.items.map((item, index) => ({
              label: item.label,
              category: item.category,
              priority: item.priority ?? "medium",
              sort_order: item.sort_order ?? index,
              notes: item.notes,
              default_checked: item.default_checked ?? false,
            })),
            replaceExistingItems: args.replace_existing_items ?? true,
          },
        );

        return textResult({
          success: true,
          message: `Stored vehicle checklist: ${args.name}`,
          checklist,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "add_vehicle_maintenance_task",
    "Create a recurring or one-time vehicle maintenance task.",
    {
      vehicle_id: z.string().uuid().describe("Vehicle UUID"),
      name: z.string().describe("Task name"),
      category: z.string().describe(
        "Task category, such as engine_fluids, filters, brakes_tires, battery_electrical",
      ),
      description: z.string().optional().describe("Short task description"),
      interval_miles: z.number().int().positive().optional().describe(
        "Mileage interval for recurrence",
      ),
      interval_days: z.number().int().positive().optional().describe(
        "Time interval for recurrence",
      ),
      seasonal_months: z.array(z.number().int().min(1).max(12)).optional()
        .describe("Months when the task is relevant"),
      priority: prioritySchema.optional().describe("Priority level"),
      status: taskStatusSchema.optional().describe("Task status"),
      last_completed_at: z.string().optional().describe(
        "Last completed timestamp/date",
      ),
      last_completed_mileage: z.number().int().nonnegative().optional()
        .describe("Last completed mileage"),
      next_due_at: z.string().optional().describe("Next due timestamp/date"),
      next_due_mileage: z.number().int().nonnegative().optional().describe(
        "Next due mileage",
      ),
      estimated_diy_cost_min: z.number().nonnegative().optional().describe(
        "Low DIY cost estimate",
      ),
      estimated_diy_cost_max: z.number().nonnegative().optional().describe(
        "High DIY cost estimate",
      ),
      estimated_shop_cost_min: z.number().nonnegative().optional().describe(
        "Low shop cost estimate",
      ),
      estimated_shop_cost_max: z.number().nonnegative().optional().describe(
        "High shop cost estimate",
      ),
      recommended_parts_or_fluids: z.string().optional().describe(
        "Parts, fluids, oil viscosity, or OEM spec notes",
      ),
      oversell_risk: z.boolean().optional().describe(
        "Whether this task is commonly oversold",
      ),
      oversell_notes: z.string().optional().describe(
        "How to evaluate or avoid unnecessary upsells",
      ),
      watch_tags: z.array(z.string()).optional().describe(
        "Related watch-list tags",
      ),
      source: z.string().optional().describe(
        "Source of interval or recommendation",
      ),
      notes: z.string().optional().describe(
        "Human-readable explanation and service rationale",
      ),
    },
    async (args) => {
      try {
        const lastCompletedAt = normalizeOptionalDateInput(
          args.last_completed_at,
        );
        const nextDueAt = normalizeOptionalDateInput(args.next_due_at);

        const inferredDueFields = await inferTaskDueFields(
          supabase,
          args.vehicle_id,
          {
            interval_miles: args.interval_miles,
            interval_days: args.interval_days,
            last_completed_at: lastCompletedAt,
            last_completed_mileage: args.last_completed_mileage,
            next_due_at: nextDueAt,
            next_due_mileage: args.next_due_mileage,
          },
        );

        const { data, error } = await supabase
          .from("vehicle_maintenance_tasks")
          .insert(stripUndefined({
            user_id: userId,
            vehicle_id: args.vehicle_id,
            name: args.name,
            category: args.category,
            description: args.description,
            interval_miles: args.interval_miles,
            interval_days: args.interval_days,
            seasonal_months: args.seasonal_months,
            priority: args.priority ?? "medium",
            status: args.status ?? "active",
            last_completed_at: lastCompletedAt,
            last_completed_mileage: args.last_completed_mileage,
            next_due_at: inferredDueFields.nextDueAt,
            next_due_mileage: inferredDueFields.nextDueMileage,
            estimated_diy_cost_min: args.estimated_diy_cost_min,
            estimated_diy_cost_max: args.estimated_diy_cost_max,
            estimated_shop_cost_min: args.estimated_shop_cost_min,
            estimated_shop_cost_max: args.estimated_shop_cost_max,
            recommended_parts_or_fluids: args.recommended_parts_or_fluids,
            oversell_risk: args.oversell_risk ?? false,
            oversell_notes: args.oversell_notes,
            watch_tags: args.watch_tags,
            source: args.source,
            notes: args.notes,
          }))
          .select("*")
          .single();

        if (error) {
          throw new Error(`Failed to add maintenance task: ${error.message}`);
        }

        return textResult({
          success: true,
          message: `Added maintenance task: ${args.name}`,
          task: data,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "log_vehicle_maintenance",
    "Log completed vehicle maintenance and update the associated task's last/next due fields.",
    {
      vehicle_id: z.string().uuid().describe("Vehicle UUID"),
      task_id: z.string().uuid().optional().describe(
        "Related maintenance task UUID",
      ),
      task_name: z.string().optional().describe(
        "Exact related maintenance task name when the task UUID is not known",
      ),
      completed_at: z.string().optional().describe("Completion timestamp/date"),
      mileage: z.number().int().nonnegative().describe(
        "Odometer mileage at completion",
      ),
      performed_by: z.string().optional().describe(
        "Person who performed the work",
      ),
      vendor_name: z.string().optional().describe("Vendor or shop name"),
      cost: z.number().nonnegative().optional().describe("Total cost"),
      service_items: z.array(z.record(z.string(), z.unknown())).optional()
        .describe("Structured list of service items"),
      parts_fluids: z.record(z.string(), z.unknown()).optional().describe(
        "Structured parts and fluid details",
      ),
      notes: z.string().optional().describe("Work notes"),
      next_action: z.string().optional().describe("Recommended follow-up"),
      source: z.string().optional().describe("Source of the log"),
      metadata: z.record(z.string(), z.unknown()).optional().describe(
        "Additional structured metadata",
      ),
    },
    async (args) => {
      try {
        const completedAt = normalizeOptionalDateInput(args.completed_at) ??
          new Date().toISOString();
        const taskId = await resolveTaskReference(
          supabase,
          userId,
          args.vehicle_id,
          new Map<string, Record<string, unknown>>(),
          {
            task_id: args.task_id,
            task_name: args.task_name,
          },
        );

        const data = await ensureLog(supabase, userId, args.vehicle_id, {
          task_id: taskId,
          completed_at: completedAt,
          mileage: args.mileage,
          performed_by: args.performed_by,
          vendor_name: args.vendor_name,
          cost: args.cost,
          service_items: args.service_items ?? [],
          parts_fluids: args.parts_fluids ?? {},
          notes: args.notes,
          next_action: args.next_action,
          source: args.source,
          metadata: args.metadata ?? {},
        });

        let updatedTask = null;
        if (taskId) {
          const { data: task, error: taskError } = await supabase
            .from("vehicle_maintenance_tasks")
            .select("*")
            .eq("id", taskId)
            .eq("user_id", userId)
            .maybeSingle();

          if (taskError) {
            throw new Error(
              `Maintenance was logged, but task lookup failed: ${taskError.message}`,
            );
          }
          updatedTask = task;
        }

        return textResult({
          success: true,
          message: "Vehicle maintenance logged successfully",
          log: data,
          updated_task: updatedTask,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "get_upcoming_vehicle_maintenance",
    "List vehicle maintenance due soon by date, mileage, or seasonal timing.",
    {
      vehicle_id: z.string().uuid().optional().describe(
        "Optional vehicle UUID",
      ),
      days_ahead: z.number().int().nonnegative().optional().describe(
        "Days to look ahead, default 90",
      ),
      miles_ahead: z.number().int().nonnegative().optional().describe(
        "Miles to look ahead, default 3000",
      ),
      include_overdue: z.boolean().optional().describe(
        "Include overdue tasks, default true",
      ),
      priority: prioritySchema.optional().describe("Filter by priority"),
      category: z.string().optional().describe("Filter by category"),
    },
    async (args) => {
      try {
        const daysAhead = args.days_ahead ?? 90;
        const milesAhead = args.miles_ahead ?? 3000;
        const includeOverdue = args.include_overdue ?? true;
        const now = new Date();
        const cutoffDate = new Date();
        cutoffDate.setUTCDate(cutoffDate.getUTCDate() + daysAhead);

        let vehicleQuery = supabase.from("vehicles").select("*").eq(
          "user_id",
          userId,
        );
        if (args.vehicle_id) {
          vehicleQuery = vehicleQuery.eq("id", args.vehicle_id);
        }
        const { data: vehicles, error: vehicleError } = await vehicleQuery;
        if (vehicleError) {
          throw new Error(`Failed to load vehicles: ${vehicleError.message}`);
        }

        const vehicleById = new Map(
          (vehicles ?? []).map((vehicle) => [vehicle.id, vehicle]),
        );
        const vehicleIds = Array.from(vehicleById.keys());
        if (vehicleIds.length === 0) {
          return textResult({ success: true, count: 0, tasks: [] });
        }

        let taskQuery = supabase
          .from("vehicle_maintenance_tasks")
          .select("*")
          .eq("user_id", userId)
          .eq("status", "active")
          .in("vehicle_id", vehicleIds);

        if (args.priority) {
          taskQuery = taskQuery.eq("priority", args.priority);
        }
        if (args.category) {
          taskQuery = taskQuery.ilike("category", `%${args.category}%`);
        }

        const { data: tasks, error: taskError } = await taskQuery;
        if (taskError) {
          throw new Error(
            `Failed to load maintenance tasks: ${taskError.message}`,
          );
        }

        const currentMonth = new Date().getUTCMonth() + 1;
        const dueTasks = (tasks ?? [])
          .map((task) => {
            const vehicle = vehicleById.get(task.vehicle_id);
            const currentMileage = vehicle?.current_mileage ?? 0;
            const dueAt = task.next_due_at ? new Date(task.next_due_at) : null;
            const seasonalMonths = normalizeSeasonalMonths(
              task.seasonal_months,
            );
            const dateRelevantForSeason = isSeasonRelevant(
              dueAt,
              seasonalMonths,
              currentMonth,
            );
            const dueByDate = dueAt
              ? dueAt <= cutoffDate && dateRelevantForSeason
              : false;
            const overdueByDate = dueAt
              ? dueAt < now && dateRelevantForSeason
              : false;
            const dueByMileage = typeof task.next_due_mileage === "number"
              ? task.next_due_mileage <= currentMileage + milesAhead &&
                dateRelevantForSeason
              : false;
            const overdueByMileage = typeof task.next_due_mileage === "number"
              ? task.next_due_mileage <= currentMileage &&
                dateRelevantForSeason
              : false;
            const seasonalNow = seasonalMonths.length > 0 &&
              seasonalMonths.includes(currentMonth);

            const reasons = [];
            if (dueByDate) {
              reasons.push(overdueByDate ? "overdue_by_date" : "due_by_date");
            }
            if (dueByMileage) {
              reasons.push(
                overdueByMileage ? "overdue_by_mileage" : "due_by_mileage",
              );
            }
            if (seasonalNow) reasons.push("seasonal_now");

            const daysUntilDue = dueAt
              ? Math.ceil(
                (dueAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
              )
              : null;
            const milesUntilDue = typeof task.next_due_mileage === "number"
              ? task.next_due_mileage - currentMileage
              : null;
            const urgencyFractions = [
              ...(typeof daysUntilDue === "number"
                ? [daysUntilDue / Math.max(daysAhead, 1)]
                : []),
              ...(typeof milesUntilDue === "number"
                ? [milesUntilDue / Math.max(milesAhead, 1)]
                : []),
            ];

            return {
              ...task,
              vehicle,
              due_reasons: reasons,
              current_mileage: currentMileage,
              days_until_due: daysUntilDue,
              miles_until_due: milesUntilDue,
              urgency_fraction: urgencyFractions.length > 0
                ? Math.min(...urgencyFractions)
                : Number.MAX_SAFE_INTEGER,
            };
          })
          .filter((task) => {
            if (task.due_reasons.length === 0) {
              return false;
            }
            if (includeOverdue) {
              return true;
            }
            return !task.due_reasons.some((reason: string) =>
              reason.startsWith("overdue")
            );
          })
          .sort((a, b) => {
            const priorityOrder: Record<string, number> = {
              urgent: 0,
              high: 1,
              medium: 2,
              low: 3,
            };
            const aOverdue = a.due_reasons.some((reason: string) =>
                reason.startsWith("overdue")
              )
              ? 0
              : 1;
            const bOverdue = b.due_reasons.some((reason: string) =>
                reason.startsWith("overdue")
              )
              ? 0
              : 1;
            if (aOverdue !== bOverdue) {
              return aOverdue - bOverdue;
            }
            const priorityDelta = priorityOrder[a.priority] -
              priorityOrder[b.priority];
            if (priorityDelta !== 0) {
              return priorityDelta;
            }
            const urgencyDelta = a.urgency_fraction - b.urgency_fraction;
            if (urgencyDelta !== 0) {
              return urgencyDelta;
            }
            return (a.miles_until_due ?? Number.MAX_SAFE_INTEGER) -
              (b.miles_until_due ?? Number.MAX_SAFE_INTEGER);
          });

        return textResult({
          success: true,
          days_ahead: daysAhead,
          miles_ahead: milesAhead,
          count: dueTasks.length,
          tasks: dueTasks,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "search_vehicle_maintenance_history",
    "Search vehicle maintenance logs by vehicle, task, category, vendor, date, or mileage.",
    {
      vehicle_id: z.string().uuid().optional().describe(
        "Optional vehicle UUID",
      ),
      task_name: z.string().optional().describe("Partial task name"),
      category: z.string().optional().describe("Partial task category"),
      vendor_name: z.string().optional().describe("Partial vendor name"),
      date_from: z.string().optional().describe("Start date"),
      date_to: z.string().optional().describe("End date"),
      mileage_min: z.number().int().nonnegative().optional().describe(
        "Minimum mileage",
      ),
      mileage_max: z.number().int().nonnegative().optional().describe(
        "Maximum mileage",
      ),
    },
    async (args) => {
      try {
        let taskIds: string[] | null = null;
        if (args.task_name || args.category) {
          let taskQuery = supabase
            .from("vehicle_maintenance_tasks")
            .select("id, name, category")
            .eq("user_id", userId);

          if (args.vehicle_id) {
            taskQuery = taskQuery.eq("vehicle_id", args.vehicle_id);
          }
          if (args.task_name) {
            taskQuery = taskQuery.ilike("name", `%${args.task_name}%`);
          }
          if (args.category) {
            taskQuery = taskQuery.ilike("category", `%${args.category}%`);
          }

          const { data: matchingTasks, error: taskError } = await taskQuery;
          if (taskError) {
            throw new Error(`Failed to search tasks: ${taskError.message}`);
          }

          taskIds = (matchingTasks ?? []).map((task) => task.id);
          if (args.category && taskIds.length === 0) {
            return textResult({ success: true, count: 0, logs: [] });
          }
        }

        let logQuery = supabase
          .from("vehicle_maintenance_logs")
          .select(`
            *,
            vehicles ( id, name, year, make, model, trim, current_mileage ),
            vehicle_maintenance_tasks ( id, name, category, priority )
          `)
          .eq("user_id", userId);

        if (args.vehicle_id) {
          logQuery = logQuery.eq("vehicle_id", args.vehicle_id);
        }
        if (args.category && taskIds) {
          logQuery = logQuery.in("task_id", taskIds);
        }
        if (args.vendor_name) {
          logQuery = logQuery.ilike("vendor_name", `%${args.vendor_name}%`);
        }
        if (args.date_from) {
          logQuery = logQuery.gte("completed_at", args.date_from);
        }
        if (args.date_to) logQuery = logQuery.lte("completed_at", args.date_to);
        if (typeof args.mileage_min === "number") {
          logQuery = logQuery.gte("mileage", args.mileage_min);
        }
        if (typeof args.mileage_max === "number") {
          logQuery = logQuery.lte("mileage", args.mileage_max);
        }

        const { data, error } = await logQuery.order("completed_at", {
          ascending: false,
        });
        if (error) {
          throw new Error(
            `Failed to search maintenance history: ${error.message}`,
          );
        }

        const taskIdSet = new Set(taskIds ?? []);
        const taskNameNeedle = normalizeStringForKey(args.task_name);
        const filteredLogs = (data ?? []).filter((log) => {
          const linkedTask = log.vehicle_maintenance_tasks as
            | Record<string, unknown>
            | null;

          if (args.category && !taskIdSet.has(String(log.task_id ?? ""))) {
            return false;
          }

          if (!args.task_name) {
            return true;
          }

          if (taskIdSet.has(String(log.task_id ?? ""))) {
            return true;
          }

          const linkedTaskName = normalizeStringForKey(linkedTask?.name);
          if (linkedTaskName.includes(taskNameNeedle)) {
            return true;
          }

          const logText = normalizeStringForKey([
            log.notes,
            log.next_action,
            log.source,
            stableSerialize(log.service_items ?? []),
          ].join(" "));

          return logText.includes(taskNameNeedle);
        });

        return textResult({
          success: true,
          count: filteredLogs.length,
          logs: filteredLogs,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "get_vehicle_timeline",
    "Return timeline items and recurring projections through a target mileage.",
    {
      vehicle_id: z.string().uuid().describe("Vehicle UUID"),
      from_mileage: z.number().int().nonnegative().optional().describe(
        "Starting mileage; defaults to vehicle current mileage",
      ),
      to_mileage: z.number().int().positive().optional().describe(
        "Ending mileage; defaults to 150000",
      ),
      include_completed: z.boolean().optional().describe(
        "Include completed timeline rows",
      ),
    },
    async (args) => {
      try {
        const { data: vehicle, error: vehicleError } = await supabase
          .from("vehicles")
          .select("*")
          .eq("id", args.vehicle_id)
          .eq("user_id", userId)
          .single();

        if (vehicleError) {
          throw new Error(`Failed to load vehicle: ${vehicleError.message}`);
        }

        const fromMileage = args.from_mileage ?? vehicle.current_mileage ?? 0;
        const toMileage = args.to_mileage ?? 150000;
        const baseDate = vehicle.mileage_as_of ??
          new Date().toISOString().slice(0, 10);
        const annualMilesEstimate = vehicle.annual_miles_estimate ?? 13500;
        const timelineStartDate = estimateDateForMileage(
          fromMileage,
          vehicle.current_mileage ?? fromMileage,
          baseDate,
          annualMilesEstimate,
        );
        const timelineEndDate = estimateDateForMileage(
          toMileage,
          vehicle.current_mileage ?? fromMileage,
          baseDate,
          annualMilesEstimate,
        );
        let timelineQuery = supabase
          .from("vehicle_timeline_items")
          .select("*")
          .eq("user_id", userId)
          .eq("vehicle_id", args.vehicle_id)
          .or(
            `and(target_mileage.gte.${fromMileage},target_mileage.lte.${toMileage}),and(target_mileage.is.null,target_date.gte.${timelineStartDate},target_date.lte.${timelineEndDate})`,
          );

        if (!args.include_completed) {
          timelineQuery = timelineQuery.neq("status", "completed");
        }

        const { data: timelineItems, error: timelineError } =
          await timelineQuery;
        if (timelineError) {
          throw new Error(
            `Failed to load timeline items: ${timelineError.message}`,
          );
        }

        const { data: tasks, error: taskError } = await supabase
          .from("vehicle_maintenance_tasks")
          .select("*")
          .eq("user_id", userId)
          .eq("vehicle_id", args.vehicle_id)
          .eq("status", "active");

        if (taskError) {
          throw new Error(
            `Failed to load recurring tasks: ${taskError.message}`,
          );
        }

        const projections = [];
        for (const task of tasks ?? []) {
          const seasonalMonths = normalizeSeasonalMonths(task.seasonal_months);
          if (task.interval_miles) {
            let mileage = task.next_due_mileage ?? task.interval_miles;
            while (mileage < fromMileage) {
              mileage += task.interval_miles;
            }
            while (mileage <= toMileage) {
              const targetDate = estimateDateForMileage(
                mileage,
                vehicle.current_mileage ?? fromMileage,
                baseDate,
                annualMilesEstimate,
              );
              if (dateMatchesSeason(targetDate, seasonalMonths)) {
                projections.push({
                  title: task.name,
                  category: task.category,
                  item_type: "projected",
                  projection_source: "task_recurrence",
                  target_mileage: mileage,
                  target_date: targetDate,
                  priority: task.priority,
                  task_id: task.id,
                  notes: task.notes,
                });
              }
              mileage += task.interval_miles;
            }
          }

          if (!task.interval_miles && task.interval_days && task.next_due_at) {
            let dueDate = new Date(task.next_due_at);
            const endDate = new Date(`${timelineEndDate}T12:00:00Z`);
            while (dueDate <= endDate) {
              if (dateMatchesSeason(dueDate, seasonalMonths)) {
                const projectedDate = dueDate.toISOString().slice(0, 10);
                const projectedMileage = estimateMileageForDate(
                  projectedDate,
                  vehicle.current_mileage ?? fromMileage,
                  baseDate,
                  annualMilesEstimate,
                );
                if (
                  projectedMileage >= fromMileage &&
                  projectedMileage <= toMileage
                ) {
                  projections.push({
                    title: task.name,
                    category: task.category,
                    item_type: "projected",
                    projection_source: "task_schedule",
                    target_mileage: projectedMileage,
                    target_date: projectedDate,
                    priority: task.priority,
                    task_id: task.id,
                    notes: task.notes,
                  });
                }
              }

              dueDate.setUTCDate(dueDate.getUTCDate() + task.interval_days);
            }
          }
        }

        const explicitTimelineKeys = new Set(
          (timelineItems ?? []).map((item) =>
            [
              item.task_id ?? "",
              item.target_mileage ?? "",
              item.target_date ?? "",
              item.title ?? "",
            ].join("::")
          ),
        );

        const dedupedProjections = projections.filter((item) => {
          const key = [
            item.task_id ?? "",
            item.target_mileage ?? "",
            item.target_date ?? "",
            item.title ?? "",
          ].join("::");
          return !explicitTimelineKeys.has(key);
        });

        const combined = [...(timelineItems ?? []), ...dedupedProjections]
          .sort((a, b) => {
            const mileageA = a.target_mileage ?? Number.MAX_SAFE_INTEGER;
            const mileageB = b.target_mileage ?? Number.MAX_SAFE_INTEGER;
            if (mileageA !== mileageB) return mileageA - mileageB;
            return String(a.target_date ?? "9999-12-31").localeCompare(
              String(b.target_date ?? "9999-12-31"),
            );
          });

        return textResult({
          success: true,
          vehicle,
          from_mileage: fromMileage,
          to_mileage: toMileage,
          count: combined.length,
          timeline: combined,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "get_vehicle_watch_list",
    "Return active watch-list concerns for a vehicle.",
    {
      vehicle_id: z.string().uuid().describe("Vehicle UUID"),
      status: z.enum(["active", "resolved", "archived"]).optional().describe(
        "Watch status, default active",
      ),
    },
    async (args) => {
      try {
        const { data, error } = await supabase
          .from("vehicle_watch_items")
          .select("*")
          .eq("user_id", userId)
          .eq("vehicle_id", args.vehicle_id)
          .eq("status", args.status ?? "active");

        if (error) {
          throw new Error(`Failed to load watch list: ${error.message}`);
        }

        const watchItems = sortWatchItems(data ?? []);
        if (watchItems.length > 0 || (args.status ?? "active") !== "active") {
          return textResult({
            success: true,
            count: watchItems.length,
            watch_items: watchItems,
          });
        }

        const { data: tasks, error: taskError } = await supabase
          .from("vehicle_maintenance_tasks")
          .select("name, watch_tags")
          .eq("user_id", userId)
          .eq("vehicle_id", args.vehicle_id)
          .eq("status", "active");

        if (taskError) {
          throw new Error(
            `Failed to load task watch tags: ${taskError.message}`,
          );
        }

        const derivedWatchItems = sortWatchItems(
          buildDerivedWatchItemsFromTaskTags(
            userId,
            args.vehicle_id,
            tasks ?? [],
          ),
        );

        return textResult({
          success: true,
          count: derivedWatchItems.length,
          watch_items: derivedWatchItems,
          generated_from_task_watch_tags: true,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "get_vehicle_checklist",
    "Return yearly, pre-winter, highway-trip, or custom vehicle checklists.",
    {
      vehicle_id: z.string().uuid().optional().describe(
        "Optional vehicle UUID",
      ),
      checklist_type: checklistTypeSchema.optional().describe("Checklist type"),
    },
    async (args) => {
      try {
        let checklistQuery = supabase
          .from("vehicle_checklists")
          .select("*")
          .eq("user_id", userId);

        if (args.vehicle_id) {
          checklistQuery = checklistQuery.eq("vehicle_id", args.vehicle_id);
        }
        if (args.checklist_type) {
          checklistQuery = checklistQuery.eq(
            "checklist_type",
            args.checklist_type,
          );
        }

        const { data: checklists, error: checklistError } = await checklistQuery
          .order("name", { ascending: true });
        if (checklistError) {
          throw new Error(
            `Failed to load checklists: ${checklistError.message}`,
          );
        }

        const checklistIds = (checklists ?? []).map((checklist) =>
          checklist.id
        );
        if (checklistIds.length === 0) {
          if (args.vehicle_id) {
            const defaultChecklists = buildDefaultChecklistResults(
              userId,
              args.vehicle_id,
              args.checklist_type,
            );
            return textResult({
              success: true,
              count: defaultChecklists.length,
              checklists: defaultChecklists,
              generated_from_default_templates: true,
            });
          }

          return textResult({ success: true, count: 0, checklists: [] });
        }

        const { data: items, error: itemError } = await supabase
          .from("vehicle_checklist_items")
          .select("*")
          .eq("user_id", userId)
          .in("checklist_id", checklistIds)
          .order("sort_order", { ascending: true });

        if (itemError) {
          throw new Error(
            `Failed to load checklist items: ${itemError.message}`,
          );
        }

        const itemsByChecklist = new Map<string, unknown[]>();
        for (const item of items ?? []) {
          const existing = itemsByChecklist.get(item.checklist_id) ?? [];
          existing.push(item);
          itemsByChecklist.set(item.checklist_id, existing);
        }

        const result = (checklists ?? []).map((checklist) => ({
          ...checklist,
          items: itemsByChecklist.get(checklist.id) ?? [],
        }));

        return textResult({
          success: true,
          count: result.length,
          checklists: result,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "import_vehicle_plan",
    "Create or update a complete vehicle maintenance plan in one call.",
    {
      vehicle: z.object({
        id: z.string().uuid().optional().describe(
          "Existing vehicle UUID to update, if known",
        ),
        name: z.string().describe("Vehicle display name"),
        year: z.number().int().optional().describe("Vehicle model year"),
        make: z.string().optional().describe("Vehicle make"),
        model: z.string().optional().describe("Vehicle model"),
        trim: z.string().optional().describe("Vehicle trim"),
        engine: z.string().optional().describe("Engine or drivetrain"),
        vin: z.string().optional().describe("VIN"),
        license_plate: z.string().optional().describe("License plate"),
        current_mileage: z.number().int().nonnegative().optional().describe(
          "Current odometer mileage",
        ),
        mileage_as_of: z.string().optional().describe(
          "Current mileage date",
        ),
        annual_miles_min: z.number().int().nonnegative().optional().describe(
          "Low-end annual mileage estimate",
        ),
        annual_miles_max: z.number().int().nonnegative().optional().describe(
          "High-end annual mileage estimate",
        ),
        annual_miles_estimate: z.number().int().positive().optional()
          .describe("Planning mileage midpoint"),
        climate_notes: z.string().optional().describe("Climate notes"),
        driving_notes: z.string().optional().describe("Driving notes"),
        reliability_goal: z.string().optional().describe(
          "Owner reliability goal",
        ),
        tire_installed_at_mileage: z.number().int().nonnegative().optional()
          .describe("Mileage when current tires were installed"),
        tire_warranty_miles: z.number().int().nonnegative().optional()
          .describe("Tire mileage warranty"),
        tire_details: z.string().optional().describe("Tire details"),
        metadata: z.record(z.string(), z.unknown()).optional().describe(
          "Additional structured vehicle metadata",
        ),
      }).describe("Vehicle record to create or update"),
      tasks: z.array(z.object({
        id: z.string().uuid().optional().describe(
          "Existing task UUID to update, if known",
        ),
        name: z.string().describe("Task name"),
        category: z.string().describe("Task category"),
        description: z.string().optional().describe("Task description"),
        interval_miles: z.number().int().positive().optional().describe(
          "Mileage interval",
        ),
        interval_days: z.number().int().positive().optional().describe(
          "Day interval",
        ),
        seasonal_months: z.array(z.number().int().min(1).max(12)).optional()
          .describe("Relevant months"),
        priority: prioritySchema.optional().describe("Priority"),
        status: taskStatusSchema.optional().describe("Task status"),
        last_completed_at: z.string().optional().describe(
          "Last completed date or timestamp",
        ),
        last_completed_mileage: z.number().int().nonnegative().optional()
          .describe("Last completed mileage"),
        next_due_at: z.string().optional().describe(
          "Next due date or timestamp",
        ),
        next_due_mileage: z.number().int().nonnegative().optional().describe(
          "Next due mileage",
        ),
        estimated_diy_cost_min: z.number().nonnegative().optional().describe(
          "Low DIY cost",
        ),
        estimated_diy_cost_max: z.number().nonnegative().optional().describe(
          "High DIY cost",
        ),
        estimated_shop_cost_min: z.number().nonnegative().optional().describe(
          "Low shop cost",
        ),
        estimated_shop_cost_max: z.number().nonnegative().optional().describe(
          "High shop cost",
        ),
        recommended_parts_or_fluids: z.string().optional().describe(
          "Parts or fluids guidance",
        ),
        oversell_risk: z.boolean().optional().describe("Oversell flag"),
        oversell_notes: z.string().optional().describe("Oversell notes"),
        watch_tags: z.array(z.string()).optional().describe("Watch tags"),
        source: z.string().optional().describe("Task source"),
        notes: z.string().optional().describe("Task notes"),
      })).optional().describe("Maintenance tasks to create or update"),
      logs: z.array(z.object({
        id: z.string().uuid().optional().describe(
          "Existing maintenance log UUID to update, if known",
        ),
        task_id: z.string().uuid().optional().describe(
          "Linked task UUID, if known",
        ),
        task_name: z.string().optional().describe(
          "Linked task name for same-call resolution",
        ),
        completed_at: z.string().optional().describe(
          "Completion date or timestamp",
        ),
        mileage: z.number().int().nonnegative().describe("Odometer mileage"),
        performed_by: z.string().optional().describe("Who performed work"),
        vendor_name: z.string().optional().describe("Vendor or shop"),
        cost: z.number().nonnegative().optional().describe("Total cost"),
        service_items: z.array(z.record(z.string(), z.unknown())).optional()
          .describe("Structured service items"),
        parts_fluids: z.record(z.string(), z.unknown()).optional().describe(
          "Structured parts or fluids",
        ),
        notes: z.string().optional().describe("Work notes"),
        next_action: z.string().optional().describe("Recommended follow-up"),
        source: z.string().optional().describe("Log source"),
        metadata: z.record(z.string(), z.unknown()).optional().describe(
          "Additional structured metadata",
        ),
      })).optional().describe("Completed maintenance logs to create or update"),
      timeline_items: z.array(z.object({
        title: z.string().describe("Timeline title"),
        task_id: z.string().uuid().optional().describe(
          "Linked task UUID, if known",
        ),
        task_name: z.string().optional().describe(
          "Linked task name for same-call resolution",
        ),
        category: z.string().optional().describe("Timeline category"),
        item_type: timelineTypeSchema.optional().describe("Timeline item type"),
        target_mileage: z.number().int().nonnegative().optional().describe(
          "Target mileage",
        ),
        target_date: z.string().optional().describe("Target date"),
        priority: prioritySchema.optional().describe("Priority"),
        status: timelineStatusSchema.optional().describe("Timeline status"),
        notes: z.string().optional().describe("Timeline notes"),
      })).optional().describe("Explicit timeline items to create or update"),
      watch_items: z.array(z.object({
        topic: z.string().describe("Watch-list topic"),
        priority: prioritySchema.optional().describe("Priority"),
        symptoms: z.string().optional().describe("Symptoms to watch"),
        monitoring_notes: z.string().optional().describe(
          "Monitoring guidance",
        ),
        action_threshold: z.string().optional().describe(
          "When action is warranted",
        ),
        related_task_names: z.array(z.string()).optional().describe(
          "Related task names",
        ),
        status: watchStatusSchema.optional().describe("Watch status"),
      })).optional().describe("Watch-list concerns to create or update"),
      checklists: z.array(z.object({
        name: z.string().describe("Checklist name"),
        checklist_type: checklistTypeSchema.describe("Checklist type"),
        cadence_days: z.number().int().positive().optional().describe(
          "Optional checklist cadence",
        ),
        seasonal_months: z.array(z.number().int().min(1).max(12)).optional()
          .describe("Relevant months"),
        notes: z.string().optional().describe("Checklist notes"),
        replace_existing_items: z.boolean().optional().describe(
          "Replace items not present in this call",
        ),
        items: z.array(z.object({
          label: z.string().describe("Checklist item label"),
          category: z.string().optional().describe("Checklist item category"),
          priority: prioritySchema.optional().describe(
            "Checklist item priority",
          ),
          sort_order: z.number().int().optional().describe(
            "Display order",
          ),
          notes: z.string().optional().describe("Checklist item notes"),
          default_checked: z.boolean().optional().describe(
            "Whether item defaults to checked",
          ),
        })).describe("Checklist items"),
      })).optional().describe("Checklists to create or update"),
    },
    async (args) => {
      try {
        const result = await importVehiclePlan(supabase, userId, args);
        return textResult({ success: true, ...result });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "seed_sample_vehicle_plan",
    "Seed a complete sample vehicle maintenance plan, history, timeline, watch list, and checklists.",
    {
      current_mileage: z.number().int().nonnegative().optional().describe(
        "Current mileage for the sample seed, default 49010",
      ),
      mileage_as_of: z.string().optional().describe(
        "Planning date, default 2026-05-10",
      ),
      annual_miles_estimate: z.number().int().positive().optional().describe(
        "Planning annual mileage midpoint, default 13500",
      ),
    },
    async (args) => {
      try {
        const result = await seedSampleVehiclePlan(supabase, userId, {
          currentMileage: args.current_mileage ?? 49010,
          mileageAsOf: args.mileage_as_of ?? "2026-05-10",
          annualMilesEstimate: args.annual_miles_estimate ?? 13500,
        });

        return textResult({ success: true, ...result });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

async function seedSampleVehiclePlan(
  supabase: SupabaseClient,
  userId: string,
  options: {
    currentMileage: number;
    mileageAsOf: string;
    annualMilesEstimate: number;
  },
) {
  const vehicle = await ensureVehicle(supabase, userId, {
    name: "2022 Sample Turbo Sedan",
    year: 2022,
    make: "Sample",
    model: "Turbo Sedan",
    trim: "Reference",
    engine: "1.6L Turbo",
    current_mileage: options.currentMileage,
    mileage_as_of: options.mileageAsOf,
    annual_miles_min: 12000,
    annual_miles_max: 15000,
    annual_miles_estimate: options.annualMilesEstimate,
    climate_notes:
      "Four-season climate with winter road treatment, humidity, and summer heat.",
    driving_notes:
      "Mixed local and highway driving with seasonal road wear, potholes, and winter exposure.",
    reliability_goal:
      "Maximize long-term reliability and reduce major repair risk while avoiding unnecessary dealer upsells.",
    tire_installed_at_mileage: 48688,
    tire_warranty_miles: 70000,
    tire_details:
      "Example all-season touring tires replaced and balanced 2026-05-02 at 48,688 miles; 70,000-mile warranty.",
    metadata: {
      seed_source: SAMPLE_SEED_SOURCE,
      tire_warranty_target_mileage: 118688,
    },
  });

  const vehicleId = vehicle.id as string;
  const taskResults = [];
  const taskMap = new Map<string, Record<string, unknown>>();
  for (const taskSeed of buildSampleTaskSeeds(options)) {
    const task = await ensureTask(supabase, userId, vehicleId, taskSeed);
    taskResults.push(task);
    taskMap.set(task.name as string, task);
  }

  const logResults = [];
  for (const logSeed of buildSampleLogSeeds(vehicleId, taskMap)) {
    logResults.push(await ensureLog(supabase, userId, vehicleId, logSeed));
  }

  const timelineResults = [];
  for (const timelineSeed of buildSampleTimelineSeeds(options, taskMap)) {
    timelineResults.push(
      await ensureTimelineItem(supabase, userId, vehicleId, timelineSeed),
    );
  }

  const watchResults = [];
  for (const watchSeed of buildSampleWatchSeeds(vehicleId)) {
    watchResults.push(
      await ensureWatchItem(supabase, userId, vehicleId, watchSeed),
    );
  }

  const checklistResults = [];
  for (const checklistSeed of buildSampleChecklistSeeds(vehicleId)) {
    checklistResults.push(
      await ensureChecklist(supabase, userId, vehicleId, checklistSeed),
    );
  }

  return {
    message: "Seeded sample vehicle maintenance plan",
    vehicle,
    counts: {
      tasks: taskResults.length,
      logs: logResults.length,
      timeline_items: timelineResults.length,
      watch_items: watchResults.length,
      checklists: checklistResults.length,
    },
    immediate_next_actions: [
      "Schedule wheel alignment ASAP to protect the new tires.",
      "Schedule brake fluid exchange; it is overdue and moisture-sensitive.",
      "Plan a transmission fluid drain-and-fill soon using the manufacturer-approved fluid; avoid aggressive flushes.",
      "Track spark plugs as a long-term 100,000-mile maintenance item unless updated Kia service information says otherwise.",
    ],
  };
}

async function importVehiclePlan(
  supabase: SupabaseClient,
  userId: string,
  plan: {
    vehicle: Record<string, unknown>;
    tasks?: Record<string, unknown>[];
    logs?: Record<string, unknown>[];
    timeline_items?: Record<string, unknown>[];
    watch_items?: Record<string, unknown>[];
    checklists?: Array<Record<string, unknown>>;
  },
) {
  const vehicle = await ensureVehicle(supabase, userId, {
    ...plan.vehicle,
    mileage_as_of: normalizeOptionalDateOnlyInput(
      plan.vehicle.mileage_as_of as string | undefined,
    ),
    metadata: (plan.vehicle.metadata as Record<string, unknown> | undefined) ??
      {},
  });

  const vehicleId = vehicle.id as string;
  const taskResults = [];
  const taskMap = new Map<string, Record<string, unknown>>();

  for (const task of plan.tasks ?? []) {
    const lastCompletedAt = normalizeOptionalDateInput(
      task.last_completed_at as string | undefined,
    );
    const nextDueAt = normalizeOptionalDateInput(
      task.next_due_at as string | undefined,
    );
    const inferredDueFields = await inferTaskDueFields(supabase, vehicleId, {
      interval_miles: task.interval_miles as number | undefined,
      interval_days: task.interval_days as number | undefined,
      last_completed_at: lastCompletedAt,
      last_completed_mileage: task.last_completed_mileage as number | undefined,
      next_due_at: nextDueAt,
      next_due_mileage: task.next_due_mileage as number | undefined,
    });

    const storedTask = await ensureTask(supabase, userId, vehicleId, {
      ...task,
      last_completed_at: lastCompletedAt,
      next_due_at: inferredDueFields.nextDueAt,
      next_due_mileage: inferredDueFields.nextDueMileage,
    });
    taskResults.push(storedTask);
    taskMap.set(storedTask.name as string, storedTask);
  }

  const logResults = [];
  for (const log of plan.logs ?? []) {
    const { task_name: _logTaskName, ...logWithoutTaskName } = log;
    const taskId = await resolveTaskReference(
      supabase,
      userId,
      vehicleId,
      taskMap,
      {
        task_id: log.task_id as string | undefined,
        task_name: log.task_name as string | undefined,
      },
    );

    logResults.push(await ensureLog(supabase, userId, vehicleId, {
      ...logWithoutTaskName,
      task_id: taskId,
      completed_at: normalizeOptionalDateInput(
        log.completed_at as string | undefined,
      ),
      service_items: (log.service_items as Record<string, unknown>[] | undefined) ?? [],
      parts_fluids: (log.parts_fluids as Record<string, unknown> | undefined) ?? {},
      metadata: (log.metadata as Record<string, unknown> | undefined) ?? {},
    }));
  }

  const timelineResults = [];
  for (const timelineItem of plan.timeline_items ?? []) {
    const {
      task_name: _timelineTaskName,
      ...timelineItemWithoutTaskName
    } = timelineItem;
    const taskId = await resolveTaskReference(
      supabase,
      userId,
      vehicleId,
      taskMap,
      {
        task_id: timelineItem.task_id as string | undefined,
        task_name: timelineItem.task_name as string | undefined,
      },
    );

    timelineResults.push(
      await ensureTimelineItem(supabase, userId, vehicleId, {
        ...timelineItemWithoutTaskName,
        task_id: taskId,
        target_date: normalizeOptionalDateOnlyInput(
          timelineItem.target_date as string | undefined,
        ),
      }),
    );
  }

  const watchResults = [];
  for (const watchItem of plan.watch_items ?? []) {
    watchResults.push(
      await ensureWatchItem(supabase, userId, vehicleId, watchItem),
    );
  }

  const checklistResults = [];
  for (const checklist of plan.checklists ?? []) {
    checklistResults.push(
      await ensureChecklist(supabase, userId, vehicleId, {
        checklist: {
          name: checklist.name,
          checklist_type: checklist.checklist_type,
          cadence_days: checklist.cadence_days,
          seasonal_months: checklist.seasonal_months,
          notes: checklist.notes,
        },
        items: ((checklist.items as Record<string, unknown>[] | undefined) ?? []).map(
          (item, index) => ({
            ...item,
            sort_order: item.sort_order ?? index,
            priority: item.priority ?? "medium",
            default_checked: item.default_checked ?? false,
          }),
        ),
        replaceExistingItems:
          (checklist.replace_existing_items as boolean | undefined) ?? true,
      }),
    );
  }

  return {
    message: "Imported vehicle maintenance plan",
    vehicle,
    counts: {
      tasks: taskResults.length,
      logs: logResults.length,
      timeline_items: timelineResults.length,
      watch_items: watchResults.length,
      checklists: checklistResults.length,
    },
  };
}

async function resolveTaskReference(
  supabase: SupabaseClient,
  userId: string,
  vehicleId: string,
  taskMap: Map<string, Record<string, unknown>>,
  ref: {
    task_id?: string;
    task_name?: string;
  },
) {
  if (ref.task_id) {
    return ref.task_id;
  }

  if (!ref.task_name) {
    return undefined;
  }

  const knownTask = taskMap.get(ref.task_name);
  if (knownTask?.id) {
    return knownTask.id as string;
  }

  const { data, error } = await supabase
    .from("vehicle_maintenance_tasks")
    .select("*")
    .eq("user_id", userId)
    .eq("vehicle_id", vehicleId)
    .eq("name", ref.task_name)
    .maybeSingle();

  if (error) {
    throw new Error(
      `Failed to resolve task '${ref.task_name}': ${error.message}`,
    );
  }

  if (!data) {
    throw new Error(
      `Task reference '${ref.task_name}' could not be resolved for this vehicle`,
    );
  }

  taskMap.set(data.name as string, data);
  return data.id as string;
}

async function ensureVehicle(
  supabase: SupabaseClient,
  userId: string,
  seed: Record<string, unknown>,
) {
  const vehicleId = seed.id as string | undefined;
  let query = supabase.from("vehicles").select("*").eq("user_id", userId);
  query = vehicleId ? query.eq("id", vehicleId) : query.eq("name", seed.name as string);
  const { data: existing, error: findError } = await query.maybeSingle();

  if (findError) {
    throw new Error(`Failed to look up vehicle: ${findError.message}`);
  }

  const { id: _ignoredVehicleId, ...seedWithoutId } = seed;
  const payload = stripUndefined({ user_id: userId, ...seedWithoutId });
  if (existing) {
    const { data, error } = await supabase
      .from("vehicles")
      .update(payload)
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) {
      throw new Error(`Failed to update seed vehicle: ${error.message}`);
    }
    return data;
  }

  const { data, error } = await supabase.from("vehicles").insert(payload)
    .select("*").single();
  if (error) throw new Error(`Failed to create seed vehicle: ${error.message}`);
  return data;
}

async function ensureTask(
  supabase: SupabaseClient,
  userId: string,
  vehicleId: string,
  seed: Record<string, unknown>,
) {
  const taskId = seed.id as string | undefined;
  let query = supabase
    .from("vehicle_maintenance_tasks")
    .select("*")
    .eq("user_id", userId)
    .eq("vehicle_id", vehicleId);
  query = taskId ? query.eq("id", taskId) : query.eq("name", seed.name as string);
  const { data: existing, error: findError } = await query.maybeSingle();

  if (findError) {
    throw new Error(
      `Failed to look up task '${seed.name}': ${findError.message}`,
    );
  }

  const { id: _ignoredTaskId, ...seedWithoutId } = seed;
  const payload = stripUndefined({
    user_id: userId,
    vehicle_id: vehicleId,
    ...seedWithoutId,
  });
  if (existing) {
    const { data, error } = await supabase
      .from("vehicle_maintenance_tasks")
      .update(payload)
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) {
      throw new Error(`Failed to update task '${seed.name}': ${error.message}`);
    }
    return data;
  }

  const { data, error } = await supabase.from("vehicle_maintenance_tasks")
    .insert(payload).select("*").single();
  if (error) {
    throw new Error(`Failed to create task '${seed.name}': ${error.message}`);
  }
  return data;
}

async function ensureLog(
  supabase: SupabaseClient,
  userId: string,
  vehicleId: string,
  seed: Record<string, unknown>,
) {
  const metadata = { ...((seed.metadata as Record<string, unknown> | undefined) ?? {}) };
  const logId = seed.id as string | undefined;
  const dedupeField = metadata.seed_key
    ? "seed_key"
    : metadata.import_key
    ? "import_key"
    : "import_dedupe_key";
  const dedupeValue = typeof metadata[dedupeField] === "string" && metadata[dedupeField]
    ? metadata[dedupeField] as string
    : buildMaintenanceLogDedupeKey(seed);
  metadata.import_dedupe_key = dedupeValue;
  let query = supabase
    .from("vehicle_maintenance_logs")
    .select("*")
    .eq("user_id", userId)
    .eq("vehicle_id", vehicleId);

  if (logId) {
    query = query.eq("id", logId);
  } else {
    query = query.contains("metadata", { [dedupeField]: dedupeValue });
  }

  const { data: existing, error: findError } = await query.maybeSingle();
  if (findError) {
    throw new Error(
      `Failed to look up maintenance log '${dedupeValue}': ${findError.message}`,
    );
  }

  const { id: _ignoredLogId, ...seedWithoutId } = seed;
  const payload = stripUndefined({
    user_id: userId,
    vehicle_id: vehicleId,
    ...seedWithoutId,
    metadata,
  });
  if (existing) {
    const { data, error } = await supabase
      .from("vehicle_maintenance_logs")
      .update(payload)
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) {
      throw new Error(
        `Failed to update maintenance log '${dedupeValue}': ${error.message}`,
      );
    }
    return data;
  }

  const { data, error } = await supabase.from("vehicle_maintenance_logs")
    .insert(payload).select("*").single();
  if (error) {
    throw new Error(
      `Failed to create maintenance log '${dedupeValue}': ${error.message}`,
    );
  }
  return data;
}

async function ensureTimelineItem(
  supabase: SupabaseClient,
  userId: string,
  vehicleId: string,
  seed: Record<string, unknown>,
) {
  let query = supabase
    .from("vehicle_timeline_items")
    .select("*")
    .eq("user_id", userId)
    .eq("vehicle_id", vehicleId)
    .eq("title", seed.title as string)
    .eq("item_type", (seed.item_type as string | undefined) ?? "projected");

  if (typeof seed.target_mileage === "number") {
    query = query.eq("target_mileage", seed.target_mileage);
  } else {
    query = query.is("target_mileage", null);
    if (seed.target_date) {
      query = query.eq("target_date", seed.target_date);
    } else {
      query = query.is("target_date", null);
    }
  }

  const { data: existing, error: findError } = await query.maybeSingle();
  if (findError) {
    throw new Error(
      `Failed to look up timeline item '${seed.title}': ${findError.message}`,
    );
  }

  const payload = stripUndefined({
    user_id: userId,
    vehicle_id: vehicleId,
    ...seed,
  });
  if (existing) {
    const { data, error } = await supabase
      .from("vehicle_timeline_items")
      .update(payload)
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) {
      throw new Error(
        `Failed to update timeline item '${seed.title}': ${error.message}`,
      );
    }
    return data;
  }

  const { data, error } = await supabase.from("vehicle_timeline_items").insert(
    payload,
  ).select("*").single();
  if (error) {
    throw new Error(
      `Failed to create timeline item '${seed.title}': ${error.message}`,
    );
  }
  return data;
}

async function ensureWatchItem(
  supabase: SupabaseClient,
  userId: string,
  vehicleId: string,
  seed: Record<string, unknown>,
) {
  const { data: existing, error: findError } = await supabase
    .from("vehicle_watch_items")
    .select("*")
    .eq("user_id", userId)
    .eq("vehicle_id", vehicleId)
    .eq("topic", seed.topic as string)
    .maybeSingle();

  if (findError) {
    throw new Error(
      `Failed to look up watch item '${seed.topic}': ${findError.message}`,
    );
  }

  const payload = stripUndefined({
    user_id: userId,
    vehicle_id: vehicleId,
    ...seed,
  });
  if (existing) {
    const { data, error } = await supabase
      .from("vehicle_watch_items")
      .update(payload)
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) {
      throw new Error(
        `Failed to update watch item '${seed.topic}': ${error.message}`,
      );
    }
    return data;
  }

  const { data, error } = await supabase.from("vehicle_watch_items").insert(
    payload,
  ).select("*").single();
  if (error) {
    throw new Error(
      `Failed to create watch item '${seed.topic}': ${error.message}`,
    );
  }
  return data;
}

async function ensureChecklist(
  supabase: SupabaseClient,
  userId: string,
  vehicleId: string,
  seed: {
    checklist: Record<string, unknown>;
    items: Record<string, unknown>[];
    replaceExistingItems?: boolean;
  },
) {
  const checklistSeed = seed.checklist;
  const { data: existing, error: findError } = await supabase
    .from("vehicle_checklists")
    .select("*")
    .eq("user_id", userId)
    .eq("vehicle_id", vehicleId)
    .eq("name", checklistSeed.name as string)
    .eq("checklist_type", checklistSeed.checklist_type as string)
    .maybeSingle();

  if (findError) {
    throw new Error(
      `Failed to look up checklist '${checklistSeed.name}': ${findError.message}`,
    );
  }

  const payload = stripUndefined({
    user_id: userId,
    vehicle_id: vehicleId,
    ...checklistSeed,
  });
  const checklist = existing
    ? await updateChecklist(supabase, existing.id, payload)
    : await insertChecklist(supabase, payload);

  if (seed.replaceExistingItems) {
    const keepLabels = seed.items.map((item) => item.label as string);
    let deleteQuery = supabase
      .from("vehicle_checklist_items")
      .delete()
      .eq("user_id", userId)
      .eq("checklist_id", checklist.id);

    if (keepLabels.length > 0) {
      deleteQuery = deleteQuery.not("label", "in", `(${keepLabels.map((label) => `"${label.replaceAll("\"", "\\\"")}"`).join(",")})`);
    }

    const { error: deleteError } = await deleteQuery;
    if (deleteError) {
      throw new Error(
        `Failed to sync checklist items for '${String(checklistSeed.name)}': ${deleteError.message}`,
      );
    }
  }

  const itemResults = [];
  for (const item of seed.items) {
    itemResults.push(
      await ensureChecklistItem(supabase, userId, checklist.id, item),
    );
  }

  return { ...checklist, items: itemResults };
}

async function insertChecklist(
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
) {
  const { data, error } = await supabase.from("vehicle_checklists").insert(
    payload,
  ).select("*").single();
  if (error) throw new Error(`Failed to create checklist: ${error.message}`);
  return data;
}

async function updateChecklist(
  supabase: SupabaseClient,
  id: string,
  payload: Record<string, unknown>,
) {
  const { data, error } = await supabase.from("vehicle_checklists").update(
    payload,
  ).eq("id", id).select("*").single();
  if (error) throw new Error(`Failed to update checklist: ${error.message}`);
  return data;
}

async function ensureChecklistItem(
  supabase: SupabaseClient,
  userId: string,
  checklistId: string,
  seed: Record<string, unknown>,
) {
  const { data: existing, error: findError } = await supabase
    .from("vehicle_checklist_items")
    .select("*")
    .eq("user_id", userId)
    .eq("checklist_id", checklistId)
    .eq("label", seed.label as string)
    .maybeSingle();

  if (findError) {
    throw new Error(
      `Failed to look up checklist item '${seed.label}': ${findError.message}`,
    );
  }

  const payload = stripUndefined({
    user_id: userId,
    checklist_id: checklistId,
    ...seed,
  });
  if (existing) {
    const { data, error } = await supabase
      .from("vehicle_checklist_items")
      .update(payload)
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) {
      throw new Error(
        `Failed to update checklist item '${seed.label}': ${error.message}`,
      );
    }
    return data;
  }

  const { data, error } = await supabase.from("vehicle_checklist_items").insert(
    payload,
  ).select("*").single();
  if (error) {
    throw new Error(
      `Failed to create checklist item '${seed.label}': ${error.message}`,
    );
  }
  return data;
}

function buildSampleTaskSeeds(
  options: {
    currentMileage: number;
    mileageAsOf: string;
    annualMilesEstimate: number;
  },
) {
  const estimate = (mileage: number) =>
    estimateDateForMileage(
      mileage,
      options.currentMileage,
      options.mileageAsOf,
      options.annualMilesEstimate,
    );

  return [
    {
      name: "Engine oil and filter",
      category: "engine_fluids",
      description:
        "Full synthetic oil and filter service for the 1.6T turbo engine.",
      interval_miles: 5000,
      interval_days: 182,
      priority: "high",
      last_completed_at: "2026-05-09T12:00:00Z",
      last_completed_mileage: 49010,
      next_due_mileage: 54010,
      next_due_at: asTimestamp(estimate(54010)),
      estimated_diy_cost_min: 45,
      estimated_diy_cost_max: 80,
      estimated_shop_cost_min: 80,
      estimated_shop_cost_max: 130,
      recommended_parts_or_fluids:
        "Full synthetic oil; track brand, viscosity, and manufacturer specification when known.",
      oversell_risk: false,
      watch_tags: ["Turbo oil health"],
      source: SAMPLE_SEED_SOURCE,
      notes:
        "Use a 5,000-mile or 6-month interval to protect turbo oil health. Mileage is likely to arrive before time at the current driving rate.",
    },
    {
      name: "Transmission fluid drain-and-fill",
      category: "engine_fluids",
      description: "Preventive automatic transmission fluid drain-and-fill.",
      interval_miles: 55000,
      priority: "high",
      next_due_mileage: 50000,
      next_due_at: asTimestamp(estimate(50000)),
      estimated_diy_cost_min: 80,
      estimated_diy_cost_max: 160,
      estimated_shop_cost_min: 220,
      estimated_shop_cost_max: 450,
      recommended_parts_or_fluids: "Manufacturer-approved transmission fluid.",
      oversell_risk: true,
      oversell_notes:
        "Prefer drain-and-fill. Avoid aggressive flushes unless a qualified technician has a specific diagnostic reason.",
      watch_tags: [],
      source: SAMPLE_SEED_SOURCE,
      notes:
        "Dealer flagged ATF exchange as soon. Reliability plan targets a conservative 50,000-60,000 mile drain-and-fill cadence.",
    },
    {
      name: "Brake fluid exchange",
      category: "engine_fluids",
      description:
        "Exchange hygroscopic brake fluid to reduce corrosion and boiling-risk issues.",
      interval_miles: 45000,
      interval_days: 1095,
      priority: "high",
      next_due_mileage: options.currentMileage,
      next_due_at: asTimestamp(options.mileageAsOf),
      estimated_diy_cost_min: 15,
      estimated_diy_cost_max: 40,
      estimated_shop_cost_min: 120,
      estimated_shop_cost_max: 220,
      oversell_risk: false,
      watch_tags: ["Brake moisture contamination"],
      source: SAMPLE_SEED_SOURCE,
      notes:
        "Overdue from the 48,000-mile sample recommendation. Important in humid and winter-treated road conditions because brake fluid absorbs moisture.",
    },
    {
      name: "Coolant inspection",
      category: "engine_fluids",
      description:
        "Inspect coolant level, condition, freeze protection, and visible leaks.",
      interval_days: 365,
      priority: "medium",
      next_due_at: "2027-05-10T12:00:00Z",
      estimated_diy_cost_min: 0,
      estimated_diy_cost_max: 20,
      estimated_shop_cost_min: 0,
      estimated_shop_cost_max: 80,
      oversell_risk: false,
      source: SAMPLE_SEED_SOURCE,
      notes:
        "Inspect yearly, especially before winter. Replacement should follow age, condition, mileage, or owner-manual guidance.",
    },
    {
      name: "Coolant replacement",
      category: "engine_fluids",
      description: "Coolant replacement around long-term service interval.",
      interval_miles: 100000,
      priority: "medium",
      next_due_mileage: 100000,
      next_due_at: asTimestamp(estimate(100000)),
      estimated_diy_cost_min: 50,
      estimated_diy_cost_max: 100,
      estimated_shop_cost_min: 150,
      estimated_shop_cost_max: 300,
      oversell_risk: true,
      oversell_notes:
        "Do not approve a premature coolant flush unless age, mileage, test results, condition, or manual guidance supports it.",
      source: SAMPLE_SEED_SOURCE,
      notes:
        "Plan around 100,000 miles or the age recommendation after verifying the owner manual or manufacturer service schedule.",
    },
    {
      name: "Engine air filter inspection/replacement",
      category: "filters",
      description: "Inspect engine air filter and replace based on condition.",
      interval_miles: 10000,
      priority: "medium",
      last_completed_at: "2026-05-09T12:00:00Z",
      last_completed_mileage: 49010,
      next_due_mileage: 59010,
      next_due_at: asTimestamp(estimate(59010)),
      estimated_diy_cost_min: 20,
      estimated_diy_cost_max: 45,
      estimated_shop_cost_min: 60,
      estimated_shop_cost_max: 120,
      oversell_risk: true,
      oversell_notes:
        "Do not replace blindly when it was recently replaced; inspect and replace based on condition.",
      source: SAMPLE_SEED_SOURCE,
      notes:
        "Inspect every 10,000 miles. Replace every 15,000-25,000 miles depending on filter condition and driving environment.",
    },
    {
      name: "Cabin air filter",
      category: "filters",
      description:
        "Replace cabin air filter for HVAC airflow and allergy control.",
      interval_miles: 15000,
      interval_days: 365,
      priority: "medium",
      last_completed_at: "2026-05-09T12:00:00Z",
      last_completed_mileage: 49010,
      next_due_mileage: 64010,
      next_due_at: "2027-05-09T12:00:00Z",
      estimated_diy_cost_min: 15,
      estimated_diy_cost_max: 35,
      estimated_shop_cost_min: 60,
      estimated_shop_cost_max: 120,
      oversell_risk: true,
      oversell_notes:
        "Recently replaced; future replacement should be based on interval, airflow, odor, or allergy-season needs.",
      source: SAMPLE_SEED_SOURCE,
      notes:
        "Replace every 12 months or 15,000 miles. Increase priority during allergy season.",
    },
    {
      name: "Chevron Techron fuel system cleaner",
      category: "fuel_system",
      description: "Periodic detergent fuel system cleaner maintenance.",
      interval_miles: 6500,
      priority: "low",
      next_due_mileage: 55510,
      next_due_at: asTimestamp(estimate(55510)),
      estimated_diy_cost_min: 10,
      estimated_diy_cost_max: 20,
      estimated_shop_cost_min: 0,
      estimated_shop_cost_max: 0,
      oversell_risk: false,
      watch_tags: ["Carbon buildup"],
      source: SAMPLE_SEED_SOURCE,
      notes:
        "Use Chevron Techron Concentrate Plus every 5,000-7,500 miles. Add before fill-up and take a highway drive afterward.",
    },
    {
      name: "Red Line SI-1 fuel system cleaner",
      category: "fuel_system",
      description:
        "Annual or 12,000-15,000 mile fuel system cleaner maintenance.",
      interval_miles: 13500,
      interval_days: 365,
      priority: "medium",
      last_completed_at: "2026-05-09T12:00:00Z",
      last_completed_mileage: 49010,
      next_due_mileage: 62510,
      next_due_at: "2027-05-09T12:00:00Z",
      estimated_diy_cost_min: 15,
      estimated_diy_cost_max: 25,
      estimated_shop_cost_min: 0,
      estimated_shop_cost_max: 0,
      oversell_risk: false,
      watch_tags: ["Carbon buildup"],
      source: SAMPLE_SEED_SOURCE,
      notes:
        "Last used 2026-05-09 at 49,010 miles. Use once yearly or every 12,000-15,000 miles.",
    },
    {
      name: "Tire rotation",
      category: "brakes_tires",
      description:
        "Rotate tires and record tread depth to protect tire warranty.",
      interval_miles: 5000,
      priority: "high",
      last_completed_at: "2026-05-02T12:00:00Z",
      last_completed_mileage: 48688,
      next_due_mileage: 53688,
      next_due_at: asTimestamp(estimate(53688)),
      estimated_diy_cost_min: 0,
      estimated_diy_cost_max: 20,
      estimated_shop_cost_min: 0,
      estimated_shop_cost_max: 40,
      oversell_risk: false,
      watch_tags: ["Tire wear"],
      source: SAMPLE_SEED_SOURCE,
      notes:
        "Rotate every 5,000-7,500 miles. New tire warranty baseline is 48,688 miles; warranty target is 118,688 miles.",
    },
    {
      name: "Tire pressure inspection",
      category: "brakes_tires",
      description:
        "Monthly tire pressure check with seasonal adjustment notes.",
      interval_days: 30,
      priority: "medium",
      next_due_at: "2026-06-10T12:00:00Z",
      estimated_diy_cost_min: 0,
      estimated_diy_cost_max: 0,
      estimated_shop_cost_min: 0,
      estimated_shop_cost_max: 10,
      oversell_risk: false,
      watch_tags: ["Tire wear"],
      source: SAMPLE_SEED_SOURCE,
      notes:
        "Check monthly and when temperatures swing. Record seasonal pressure changes to protect tires and fuel economy.",
    },
    {
      name: "Wheel alignment",
      category: "brakes_tires",
      description:
        "Alignment inspection and correction if out of specification.",
      interval_miles: 12000,
      interval_days: 365,
      priority: "high",
      next_due_mileage: options.currentMileage,
      next_due_at: asTimestamp(options.mileageAsOf),
      estimated_diy_cost_min: 0,
      estimated_diy_cost_max: 0,
      estimated_shop_cost_min: 90,
      estimated_shop_cost_max: 180,
      oversell_risk: false,
      watch_tags: ["Tire wear"],
      source: SAMPLE_SEED_SOURCE,
      notes:
        "Dealer flagged alignment ASAP. Do this soon because the tires are new and uneven wear can compromise the 70,000-mile warranty.",
    },
    {
      name: "Brake pad and rotor inspection",
      category: "brakes_tires",
      description:
        "Inspect pads, rotors, calipers, slide pins, and corrosion at every rotation.",
      interval_miles: 5000,
      priority: "medium",
      next_due_mileage: 54010,
      next_due_at: asTimestamp(estimate(54010)),
      estimated_diy_cost_min: 0,
      estimated_diy_cost_max: 0,
      estimated_shop_cost_min: 0,
      estimated_shop_cost_max: 60,
      oversell_risk: true,
      oversell_notes:
        "Require pad thickness, rotor measurements, symptoms, or corrosion justification before approving brake replacement.",
      watch_tags: ["Brake moisture contamination"],
      source: SAMPLE_SEED_SOURCE,
      notes:
        "Inspect every tire rotation. Winter road treatment increases corrosion risk.",
    },
    {
      name: "Battery health inspection",
      category: "battery_electrical",
      description:
        "Battery test before winter and record age, voltage, and cold-cranking health.",
      interval_days: 365,
      seasonal_months: [9, 10, 11],
      priority: "medium",
      next_due_at: "2026-10-01T12:00:00Z",
      estimated_diy_cost_min: 0,
      estimated_diy_cost_max: 20,
      estimated_shop_cost_min: 0,
      estimated_shop_cost_max: 50,
      oversell_risk: false,
      watch_tags: ["Battery aging"],
      source: SAMPLE_SEED_SOURCE,
      notes:
        "Test before each winter. Replace based on test results and cold-start behavior, not age alone.",
    },
    {
      name: "Charging system inspection",
      category: "battery_electrical",
      description: "Check alternator output and charging behavior.",
      interval_days: 730,
      priority: "medium",
      next_due_at: "2026-10-01T12:00:00Z",
      estimated_diy_cost_min: 0,
      estimated_diy_cost_max: 20,
      estimated_shop_cost_min: 40,
      estimated_shop_cost_max: 100,
      oversell_risk: false,
      watch_tags: ["Battery aging"],
      source: SAMPLE_SEED_SOURCE,
      notes:
        "Inspect every 2 years or with battery symptoms. Establish a baseline before winter 2026.",
    },
    {
      name: "Suspension inspection",
      category: "suspension_underbody",
      description:
        "Inspect bushings, struts, links, ball joints, steering components, and pothole-related wear.",
      interval_miles: 30000,
      priority: "medium",
      next_due_mileage: 60000,
      next_due_at: asTimestamp(estimate(60000)),
      estimated_diy_cost_min: 0,
      estimated_diy_cost_max: 0,
      estimated_shop_cost_min: 80,
      estimated_shop_cost_max: 150,
      oversell_risk: false,
      watch_tags: ["Tire wear"],
      source: SAMPLE_SEED_SOURCE,
      notes:
        "Inspect every 30,000 miles. Prioritize around 60,000 because rough roads and potholes accelerate suspension wear.",
    },
    {
      name: "Undercarriage wash reminders",
      category: "suspension_underbody",
      description: "Monthly undercarriage wash during road-salt season.",
      interval_days: 30,
      seasonal_months: [12, 1, 2, 3],
      priority: "medium",
      next_due_at: "2026-12-01T12:00:00Z",
      estimated_diy_cost_min: 8,
      estimated_diy_cost_max: 20,
      estimated_shop_cost_min: 10,
      estimated_shop_cost_max: 30,
      oversell_risk: false,
      watch_tags: [],
      source: SAMPLE_SEED_SOURCE,
      notes:
        "Wash monthly December through March to reduce salt corrosion risk.",
    },
    {
      name: "Rust prevention inspection",
      category: "suspension_underbody",
      description:
        "Inspect underbody and rust-prone seams before winter salt season.",
      interval_days: 365,
      seasonal_months: [9, 10, 11],
      priority: "medium",
      next_due_at: "2026-10-01T12:00:00Z",
      estimated_diy_cost_min: 0,
      estimated_diy_cost_max: 20,
      estimated_shop_cost_min: 50,
      estimated_shop_cost_max: 150,
      oversell_risk: false,
      watch_tags: [],
      source: SAMPLE_SEED_SOURCE,
      notes:
        "Inspect annually before winter. Road salt and moisture are major long-term corrosion risks.",
    },
    {
      name: "Spark plugs",
      category: "spark_ignition",
      description:
        "Replace spark plugs at 100,000 miles for long-term turbo-engine maintenance planning.",
      interval_miles: 100000,
      priority: "high",
      next_due_mileage: 100000,
      next_due_at: asTimestamp(estimate(100000)),
      estimated_diy_cost_min: 60,
      estimated_diy_cost_max: 120,
      estimated_shop_cost_min: 250,
      estimated_shop_cost_max: 500,
      recommended_parts_or_fluids:
        "OEM-compatible plugs; confirm exact gap/spec from manufacturer service information.",
      oversell_risk: false,
      watch_tags: ["Carbon buildup", "Turbo oil health"],
      source: SAMPLE_SEED_SOURCE,
      notes:
        "Track spark plugs as a 100,000-mile maintenance item unless exact Kia service information for this engine calls for a different interval.",
    },
  ];
}

function buildSampleLogSeeds(
  vehicleId: string,
  taskMap: Map<string, Record<string, unknown>>,
) {
  return [
    {
      vehicle_id: vehicleId,
      completed_at: "2026-05-02T12:00:00Z",
      mileage: 48688,
      performed_by: "Tire shop",
      vendor_name: "Discount Tire, Palatine, IL",
      cost: 896.91,
      service_items: [
        { name: "Replaced and balanced all 4 tires" },
      ],
      parts_fluids: {
        tires: "Continental Control Contact Tour M A/S",
        tire_mileage_warranty: 70000,
      },
      notes:
        "Replaced and balanced all four tires. Use 48,688 miles as the tire warranty baseline and track rotations, tread depth, pressure, alignment, and receipts.",
      next_action:
        "Schedule alignment ASAP because dealer feedback flagged it and tires are new.",
      source: SAMPLE_SEED_SOURCE,
      metadata: { seed_key: "2026-05-02-tires" },
    },
    {
      vehicle_id: vehicleId,
      completed_at: "2026-05-09T12:00:00Z",
      mileage: 49010,
      performed_by: "Dealer",
      vendor_name: "Bob Rohrman Schaumberg Kia",
      cost: 59.99,
      service_items: [
        { name: "Oil change and inspection" },
        { name: "Cabin air filter" },
        { name: "Engine air filter" },
        { name: "Red Line SI-1 Complete Fuel System Cleaner" },
      ],
      parts_fluids: {
        oil_tracking_needed: "Record oil brand and viscosity when known",
        fuel_system_cleaner: "Red Line SI-1 Complete Fuel System Cleaner",
      },
      notes:
        "Oil change and inspection completed. Cabin air filter replaced. Engine air filter replaced. Red Line SI-1 Complete Fuel System Cleaner added. Use this as the baseline for oil, filter, and fuel-cleaner planning and track oil brand and viscosity when known.",
      next_action:
        "Oil/filter next due at 54,010 miles or about 2026-10-15; follow the active filter and fuel-cleaner tasks after that.",
      source: SAMPLE_SEED_SOURCE,
      metadata: { seed_key: "2026-05-09-service-visit" },
    },
  ];
}

function buildSampleTimelineSeeds(
  options: {
    currentMileage: number;
    mileageAsOf: string;
    annualMilesEstimate: number;
  },
  taskMap: Map<string, Record<string, unknown>>,
) {
  const estimate = (mileage: number) =>
    estimateDateForMileage(
      mileage,
      options.currentMileage,
      options.mileageAsOf,
      options.annualMilesEstimate,
    );
  const taskId = (name: string) => taskMap.get(name)?.id;
  const timeline: Record<string, unknown>[] = [
    {
      title: "Tire installation and warranty baseline",
      category: "brakes_tires",
      item_type: "one_time",
      target_mileage: 48688,
      target_date: "2026-05-02",
      priority: "medium",
      notes:
        "Continental Control Contact Tour M A/S installed and balanced at 48,688 miles. Use this as the tire warranty baseline and keep receipts, rotation records, alignment history, and tread-depth notes.",
    },
    {
      title: "Wheel alignment ASAP",
      category: "brakes_tires",
      item_type: "one_time",
      target_mileage: options.currentMileage,
      target_date: options.mileageAsOf,
      priority: "high",
      task_id: taskId("Wheel alignment"),
      notes:
        "Dealer flagged alignment ASAP. Protect the new Continental tires and 70,000-mile warranty.",
    },
    {
      title: "Brake fluid exchange overdue",
      category: "engine_fluids",
      item_type: "one_time",
      target_mileage: options.currentMileage,
      target_date: options.mileageAsOf,
      priority: "high",
      task_id: taskId("Brake fluid exchange"),
      notes:
        "Overdue from the 48,000-mile recommendation and important due to moisture absorption.",
    },
    {
      title: "Transmission drain-and-fill soon",
      category: "engine_fluids",
      item_type: "one_time",
      target_mileage: 50000,
      target_date: estimate(50000),
      priority: "high",
      task_id: taskId("Transmission fluid drain-and-fill"),
      notes:
        "Use manufacturer-approved fluid. Prefer drain-and-fill and avoid aggressive flushes.",
    },
    {
      title: "Suspension inspection at 60,000 miles",
      category: "suspension_underbody",
      item_type: "projected",
      target_mileage: 60000,
      target_date: estimate(60000),
      priority: "medium",
      task_id: taskId("Suspension inspection"),
      notes:
        "Check bushings, struts, links, ball joints, and steering components after repeated pothole exposure.",
    },
    {
      title: "Spark plug maintenance milestone",
      category: "spark_ignition",
      item_type: "projected",
      target_mileage: 100000,
      target_date: estimate(100000),
      priority: "high",
      task_id: taskId("Spark plugs"),
      notes:
        "Plan spark plug replacement around 100,000 miles unless updated Kia service information for this engine calls for a different interval.",
    },
    {
      title: "Coolant replacement planning milestone",
      category: "engine_fluids",
      item_type: "projected",
      target_mileage: 100000,
      target_date: estimate(100000),
      priority: "medium",
      task_id: taskId("Coolant replacement"),
      notes:
        "Plan coolant replacement around 100,000 miles or age/manual recommendation.",
    },
    {
      title: "Tire warranty target mileage",
      category: "brakes_tires",
      item_type: "projected",
      target_mileage: 118688,
      target_date: estimate(118688),
      priority: "medium",
      task_id: taskId("Tire rotation"),
      notes:
        "70,000-mile warranty target from 48,688-mile tire installation. Keep rotation, alignment, pressure, and tread records.",
    },
  ];

  for (let mileage = 54010; mileage <= 149010; mileage += 5000) {
    timeline.push({
      title: "Oil/filter service and inspection",
      category: "engine_fluids",
      item_type: "projected",
      target_mileage: mileage,
      target_date: estimate(mileage),
      priority: "high",
      task_id: taskId("Engine oil and filter"),
      notes:
        "Reliability plan uses 5,000-mile full synthetic oil intervals for turbo oil health.",
    });
    timeline.push({
      title: "Tire rotation and brake inspection",
      category: "brakes_tires",
      item_type: "projected",
      target_mileage: mileage,
      target_date: estimate(mileage),
      priority: "high",
      task_id: taskId("Tire rotation"),
      notes:
        "Rotate tires, inspect brakes, record tread depth and tire pressure.",
    });
  }

  for (let mileage = 59010; mileage <= 149010; mileage += 10000) {
    timeline.push({
      title: "Engine air filter inspection",
      category: "filters",
      item_type: "projected",
      target_mileage: mileage,
      target_date: estimate(mileage),
      priority: "medium",
      task_id: taskId("Engine air filter inspection/replacement"),
      notes: "Inspect every 10,000 miles; replace only if dirty or restricted.",
    });
  }

  for (let mileage = 64010; mileage <= 149010; mileage += 15000) {
    timeline.push({
      title: "Cabin air filter replacement",
      category: "filters",
      item_type: "projected",
      target_mileage: mileage,
      target_date: estimate(mileage),
      priority: "medium",
      task_id: taskId("Cabin air filter"),
      notes:
        "Replace every 12 months or 15,000 miles, with allergy-season priority.",
    });
  }

  for (const mileage of [56000, 72000, 80000, 88000, 96000, 104000]) {
    timeline.push({
      title: `Dealer reference milestone at ${mileage.toLocaleString()} miles`,
      category: "dealer_reference",
      item_type: "dealer_reference",
      target_mileage: mileage,
      target_date: estimate(mileage),
      priority: mileage === 96000 ? "high" : "medium",
      notes: mileage === 96000
        ? "Dealer reference: oil/inspection, brake fluid exchange, tire rotation, cabin air filter, engine air filter. Spark plugs are tracked separately at 100,000 miles in this plan."
        : "Dealer reference: oil/inspection, tire rotation, cabin air filter, engine air filter. Reliability plan uses 5,000-mile oil intervals and condition-based filter replacement.",
    });
  }

  for (
    const date of [
      "2026-10-01",
      "2027-10-01",
      "2028-10-01",
      "2029-10-01",
      "2030-10-01",
      "2031-10-01",
      "2032-10-01",
    ]
  ) {
    timeline.push({
      title: "Pre-winter battery and rust check",
      category: "seasonal",
      item_type: "seasonal",
      target_date: date,
      priority: "medium",
      notes:
        "Before winter: battery test, rust inspection, tire pressure/tread, coolant freeze protection, washer fluid, and wipers.",
    });
  }

  for (const date of ["2026-12-01", "2027-01-01", "2027-02-01", "2027-03-01"]) {
    timeline.push({
      title: "Winter undercarriage wash",
      category: "suspension_underbody",
      item_type: "seasonal",
      target_date: date,
      priority: "medium",
      task_id: taskId("Undercarriage wash reminders"),
      notes: "Monthly wash during road-salt season to reduce corrosion risk.",
    });
  }

  return timeline;
}

function buildSampleWatchSeeds(vehicleId: string) {
  return [
    {
      vehicle_id: vehicleId,
      topic: "Carbon buildup",
      priority: "medium",
      symptoms:
        "Rough idle, misfires, hesitation, poor fuel economy, or check-engine codes.",
      monitoring_notes:
        "Monitor symptoms before approving induction service. Fuel cleaners can help fuel-system deposits but do not fully remove intake valve deposits on direct-injection engines.",
      action_threshold:
        "Consider diagnostic inspection or induction cleaning only when symptoms, codes, or manual guidance support it.",
      related_task_names: [
        "Chevron Techron fuel system cleaner",
        "Red Line SI-1 fuel system cleaner",
        "Spark plugs",
      ],
      status: "active",
    },
    {
      vehicle_id: vehicleId,
      topic: "Turbo oil health",
      priority: "high",
      symptoms:
        "Oil consumption, smoke, turbo noise, delayed oil changes, or oil spec uncertainty.",
      monitoring_notes:
        "Prioritize 5,000-mile full synthetic oil changes and track brand, viscosity, and specification.",
      action_threshold:
        "Investigate if oil level drops between changes, smoke appears, or turbo noise develops.",
      related_task_names: ["Engine oil and filter", "Spark plugs"],
      status: "active",
    },
    {
      vehicle_id: vehicleId,
      topic: "Battery aging",
      priority: "medium",
      symptoms:
        "Slow crank, warning lights, low voltage, weak cold starts, or failed load test.",
      monitoring_notes:
        "Test before winter and record voltage, age, and cold-cranking performance.",
      action_threshold:
        "Replace based on failed test or weak winter starting behavior, not age alone.",
      related_task_names: [
        "Battery health inspection",
        "Charging system inspection",
      ],
      status: "active",
    },
    {
      vehicle_id: vehicleId,
      topic: "Tire wear",
      priority: "high",
      symptoms:
        "Uneven tread wear, steering pull, vibration, pressure loss, or warranty documentation gaps.",
      monitoring_notes:
        "Protect the 70,000-mile warranty with rotations, pressure logs, alignment, tread-depth records, and receipts.",
      action_threshold:
        "Check alignment immediately after steering pull, uneven wear, or pothole impact.",
      related_task_names: [
        "Tire rotation",
        "Tire pressure inspection",
        "Wheel alignment",
      ],
      status: "active",
    },
    {
      vehicle_id: vehicleId,
      topic: "Brake moisture contamination",
      priority: "high",
      symptoms:
        "Dark fluid, soft pedal, corrosion, ABS/brake warnings, or long brake-fluid age.",
      monitoring_notes:
        "Brake fluid absorbs moisture; humidity and winter road treatment make corrosion prevention important.",
      action_threshold:
        "Exchange brake fluid now because it is overdue, then repeat every 3 years or 45,000 miles.",
      related_task_names: [
        "Brake fluid exchange",
        "Brake pad and rotor inspection",
      ],
      status: "active",
    },
  ];
}

function buildSampleChecklistSeeds(vehicleId: string) {
  return [
    {
      checklist: {
        vehicle_id: vehicleId,
        name: "Yearly ownership summary checklist",
        checklist_type: "yearly",
        cadence_days: 365,
        notes:
          "Annual review for reliability, documentation, tires, fluids, brakes, battery, and ownership basics.",
      },
      items: checklistItems([
        ["Review maintenance log and upcoming services", "records", "high"],
        ["Check open recalls or service campaigns", "records", "medium"],
        [
          "Verify oil/filter cadence and oil spec notes",
          "engine_fluids",
          "high",
        ],
        ["Inspect engine and cabin filters", "filters", "medium"],
        [
          "Check tread depth, pressure, rotation history, alignment, and tire warranty documents",
          "brakes_tires",
          "high",
        ],
        [
          "Inspect brake pads, rotors, brake fluid condition, and brake fluid age",
          "brakes_tires",
          "high",
        ],
        ["Test battery and charging system", "battery_electrical", "medium"],
        [
          "Inspect coolant, washer fluid, lights, wipers, and visible belts/hoses",
          "general",
          "medium",
        ],
        [
          "Inspect suspension and steering after noises, vibration, pull, or pothole impacts",
          "suspension_underbody",
          "medium",
        ],
        [
          "Inspect underbody and rust-prone areas",
          "suspension_underbody",
          "medium",
        ],
        [
          "Review insurance, registration, and roadside assistance",
          "ownership",
          "low",
        ],
      ]),
    },
    {
      checklist: {
        vehicle_id: vehicleId,
        name: "Pre-winter checklist",
        checklist_type: "pre_winter",
        cadence_days: 365,
        seasonal_months: [9, 10, 11],
        notes:
          "Cold-weather preparation checklist for starts, tires, visibility, corrosion, and emergency readiness.",
      },
      items: checklistItems([
        ["Battery health and voltage/CCA test", "battery_electrical", "high"],
        ["Tire pressure and tread depth", "brakes_tires", "high"],
        ["Winter-capable washer fluid", "general", "medium"],
        ["Wiper blades", "general", "medium"],
        ["Coolant freeze protection", "engine_fluids", "medium"],
        ["Brake fluid status", "engine_fluids", "high"],
        ["Lights and defrosters", "general", "medium"],
        ["Rust and underbody inspection", "suspension_underbody", "medium"],
        ["Emergency kit", "safety", "medium"],
        [
          "Plan monthly undercarriage washes December through March",
          "suspension_underbody",
          "medium",
        ],
      ]),
    },
    {
      checklist: {
        vehicle_id: vehicleId,
        name: "Long highway trip checklist",
        checklist_type: "highway_trip",
        notes: "Quick road-trip readiness check before longer highway drives.",
      },
      items: checklistItems([
        [
          "Tire pressures, tread, visible damage, and spare/inflator status",
          "brakes_tires",
          "high",
        ],
        ["Oil level and next oil due mileage", "engine_fluids", "high"],
        ["Coolant level and warning lights", "engine_fluids", "medium"],
        ["Washer fluid and wipers", "general", "medium"],
        ["Brake feel and brake noise", "brakes_tires", "high"],
        ["Exterior lights", "general", "medium"],
        ["Phone charger and route/weather check", "trip", "low"],
        [
          "Registration, insurance, and roadside assistance",
          "ownership",
          "medium",
        ],
        ["Emergency kit", "safety", "medium"],
        ["Confirm no unresolved urgent maintenance items", "records", "high"],
      ]),
    },
  ];
}

function checklistItems(items: [string, string, string][]) {
  return items.map(([label, category, priority], index) => ({
    label,
    category,
    priority,
    sort_order: index + 1,
    notes: "",
  }));
}

app.get("*", (c) => {
  return c.json({
    status: "ok",
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
  });
});

app.post("*", async (c) => {
  try {
    patchAcceptHeaderIfNeeded(c);

    const expected = Deno.env.get("MCP_ACCESS_KEY");
    if (!expected) {
      return c.json({ error: "MCP_ACCESS_KEY not configured" }, 500);
    }

    const key = c.req.query("key") || c.req.header("x-access-key");
    if (!key || key !== expected) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    );
    const userId = requireEnv("DEFAULT_USER_ID");

    const server = new McpServer({
      name: "car-maintenance",
      version: SERVICE_VERSION,
    });
    registerTools(server, supabase, userId);

    const transport = new StreamableHTTPTransport();
    await server.connect(transport);
    return transport.handleRequest(c);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 500);
  }
});

Deno.serve(app.fetch);
