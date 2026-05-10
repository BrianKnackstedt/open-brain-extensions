# Car Maintenance Tracker

Track vehicle maintenance using both mileage and time intervals, keep service history with odometer readings, surface upcoming work before it becomes urgent, and optionally seed a reusable sample vehicle plan.

## Why This Matters

Vehicle maintenance is not just a calendar problem. Oil changes, tire rotations, fluid exchanges, filters, seasonal corrosion prevention, and battery checks are driven by both time and mileage. A generic home-maintenance tracker can store reminders, but it cannot model a vehicle well enough to answer questions like:

- What is overdue by mileage right now?
- Which services are likely due in the next 90 days?
- When did I last service the car, and at what mileage?
- Which dealership recommendations are probably valid versus oversold?
- What should I watch on a turbo direct-injection car in harsh seasonal conditions?

This extension adds those vehicle-specific concepts directly to Open Brain.

## What It Does

- Tracks one or more vehicles per user.
- Stores recurring maintenance tasks with mileage intervals, time intervals, or both.
- Logs completed maintenance with date, odometer, vendor, cost, parts, and notes.
- Calculates and stores next due mileage and next due date.
- Returns upcoming maintenance based on time, mileage, or seasonal relevance.
- Builds a projected mileage timeline through major service milestones.
- Tracks watch-list concerns such as carbon buildup, turbo oil health, battery aging, tire wear, and brake fluid moisture contamination.
- Stores reusable checklists for yearly ownership review, pre-winter prep, and long highway trips.
- Seeds a sample vehicle maintenance plan for demo and testing.

## How It Differs From Home Maintenance

The existing home-maintenance tracker is centered around date-based recurring tasks and generic maintenance logs. This extension adds automotive-specific structure:

- First-class vehicle records
- Odometer-aware maintenance logs
- Mileage-based recurrence
- Combined mileage and time due logic
- Tire warranty tracking
- Cost ranges for DIY and shop planning
- Oversell guidance on common dealer recommendations
- Projected timeline output from current mileage through long-term milestones

## Prerequisites

- Working Open Brain setup
- Supabase project configured
- Supabase CLI installed and authenticated
- Familiarity with the same remote MCP deployment pattern used by the other local extensions

## Credential Tracker

Copy this block to a text editor and fill it in during setup.

```text
CAR MAINTENANCE -- CREDENTIAL TRACKER
-------------------------------------

SUPABASE
  Project URL:           ____________
  Service role key:      ____________
  Project ref:           ____________

OPEN BRAIN
  Default user ID:       ____________
  MCP access key:        ____________
  MCP server URL:        ____________
  MCP connection URL:    ____________

OPTIONAL
  Function name:         car-maintenance-mcp

-------------------------------------
```

## Files

- `schema.sql` -- Supabase schema for vehicles, tasks, logs, timeline items, watch items, and checklists
- `index.ts` -- MCP server implementation
- `metadata.json` -- Extension metadata
- `deno.json` -- Deno tasks and pinned imports
- Shared Open Brain and Supabase runtime secrets -- reused by this extension

## Setup

### 1. Run The Schema

Open your Supabase SQL Editor and run the contents of `schema.sql`.

The schema creates:

- `vehicles`
- `vehicle_maintenance_tasks`
- `vehicle_maintenance_logs`
- `vehicle_timeline_items`
- `vehicle_watch_items`
- `vehicle_checklists`
- `vehicle_checklist_items`

It also creates:

- indexes for common vehicle and due-date queries
- `updated_at` triggers
- a helper for mileage-to-date estimation
- a trigger that updates maintenance tasks after a maintenance log is inserted
- service-role RLS policies

### 2. Configure Environment Variables

Reuse the shared Open Brain and Supabase runtime secrets that already exist for your base deployment.

Expected to already exist:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `MCP_ACCESS_KEY`
- `DEFAULT_USER_ID`

Optional extension-specific override:

- `CAR_MAINTENANCE_FUNCTION_NAME`

Only set `CAR_MAINTENANCE_FUNCTION_NAME` if you deploy this extension under a non-default function name.

Example:

```powershell
supabase secrets set CAR_MAINTENANCE_FUNCTION_NAME=car-maintenance-mcp
```

If you are targeting a specific project ref, add `--project-ref your-project-ref` to the command.

### 3. Optional Local Validation

Most users can skip this step. It is mainly for maintainers or contributors who want to run a local type/format check before deployment.

If you do have Deno installed, run from this extension folder:

```powershell
deno check index.ts
deno fmt --check index.ts
```

If `deno` is not installed or not on `PATH`, skip this step and continue with deployment and remote verification.

### 4. Deploy The Edge Function

Use the same remote MCP deployment flow as the other Open Brain extensions.

Create the function scaffold with:

```bash
supabase functions new car-maintenance-mcp
```

Then copy this extension's `index.ts` and `deno.json` into the generated function folder before deploying.

Deploy with:

```bash
supabase functions deploy car-maintenance-mcp --no-verify-jwt
```

Suggested function name:

```text
car-maintenance-mcp
```

If you deploy under a different function name, set the optional override secret:

```bash
supabase secrets set CAR_MAINTENANCE_FUNCTION_NAME=<YOUR_FUNCTION_NAME>
```

### 5. Connect To Your AI Client

Register the deployed remote MCP endpoint using your normal Open Brain / MCP connection flow.

## MCP Tools

### `add_vehicle`

Creates a vehicle record with mileage, climate, tire, and planning metadata.

### `update_vehicle_mileage`

Updates current odometer mileage and the date of that reading.

### `add_vehicle_timeline_item`

Creates or updates a vehicle timeline item such as a milestone, dealer reference, seasonal reminder, or one-time follow-up.

### `add_vehicle_watch_item`

Creates or updates a vehicle watch-list concern with monitoring notes and action thresholds.

### `add_vehicle_checklist`

Creates or updates a vehicle checklist and its ordered items. By default, rerunning the tool replaces older checklist items that are not included in the new call.

### `import_vehicle_plan`

Creates or updates a complete vehicle maintenance plan in one MCP call. The import payload can include the vehicle record, recurring tasks, completed logs, explicit timeline items, watch-list concerns, and checklists.

Task-linked logs and timeline items can reference tasks either by `task_id` or by `task_name`, which lets a single import call create tasks and then attach later sections to those tasks without a second round trip.

Repeated imports use stricter maintenance-log deduplication. If a log does not provide an explicit metadata key such as `import_key`, the extension derives a deterministic `import_dedupe_key` from the log's completion date, mileage, linked task, vendor, performer, source, service items, and parts/fluids so reruns update the same row instead of inserting duplicates.

### `add_vehicle_maintenance_task`

Creates a recurring or one-time task with mileage interval, day interval, cost estimates, parts/fluid notes, and oversell guidance.

### `log_vehicle_maintenance`

Logs completed service with mileage, cost, vendor, service items, parts/fluids, notes, and recommended next action.

### `get_upcoming_vehicle_maintenance`

Returns tasks due soon by date, mileage, seasonal timing, or overdue state.

Tasks with `seasonal_months` are only returned for date or mileage due checks when the task is relevant to the current month or the stored due date's month.

### `search_vehicle_maintenance_history`

Searches logs by task name, category, vendor, date range, or mileage range.

### `get_vehicle_timeline`

Returns stored timeline items plus projected recurring maintenance rows through a target mileage.

Mileage-based and date-based projections both honor `seasonal_months`, so seasonal tasks do not appear outside their configured months.

### `get_vehicle_watch_list`

Returns active watch-list concerns and their action thresholds.

If a custom vehicle has no stored watch rows yet, the tool derives active watch-list concerns from the vehicle's task `watch_tags` so tagged plans still produce useful readback.

### `get_vehicle_checklist`

Returns yearly, pre-winter, highway-trip, or custom checklists with ordered items.

If a custom vehicle has no stored checklist rows yet, yearly, pre-winter, and highway-trip requests return default checklist templates instead of an empty result.

### `seed_sample_vehicle_plan`

Creates or updates a detailed sample vehicle plan, including vehicle info, recurring tasks, recent service history, timeline items, watch-list entries, and checklists.

## Full Import Flow

For real vehicle plans, prefer `import_vehicle_plan` over stitching together many smaller tool calls. It is intended for one-shot plan imports such as a fully specified Kia K5 maintenance baseline.

## Sample Seed Flow

Once the extension is deployed and connected, run a prompt such as:

```text
Use the car-maintenance extension to seed the sample vehicle maintenance plan.
Current mileage is 49,010 as of 2026-05-10.
```

Or call the seed tool directly if your client exposes raw MCP tool execution:

```json
{
  "tool": "seed_sample_vehicle_plan",
  "arguments": {
    "current_mileage": 49010,
    "mileage_as_of": "2026-05-10",
    "annual_miles_estimate": 13500
  }
}
```

The seed data intentionally includes only a small recent maintenance history for demo purposes and does not invent older service history.

## Verification Checklist

After deployment, verify the following:

1. Health endpoint returns service name and version.
2. `seed_sample_vehicle_plan` creates or updates the sample vehicle.
3. The two recent maintenance log entries exist.
4. Upcoming maintenance returns alignment, brake fluid, spark plugs, and transmission drain-and-fill as current high-priority items.
5. Timeline output reaches at least 150,000 miles.
6. Watch list includes carbon buildup, turbo oil health, battery aging, tire wear, and brake moisture contamination.
7. Checklists exist for yearly ownership, pre-winter, and long highway trips.

## Troubleshooting

### Unauthorized Errors

- Confirm the client is sending the correct `MCP_ACCESS_KEY`.
- Confirm the function has the same `MCP_ACCESS_KEY` configured in secrets.

### `DEFAULT_USER_ID not configured`

- Set `DEFAULT_USER_ID` in the deployed function secrets.

### Schema Errors During Setup

- Confirm the `pgcrypto` extension is available.
- Re-run `schema.sql` after checking table or trigger name conflicts.

### Due Dates Not Updating After Logging Maintenance

- Confirm the task exists and is linked through `task_id`.
- Confirm the trigger in `schema.sql` was created successfully.
- Confirm the task has either `interval_miles`, `interval_days`, or both.

### Optional Deno Validation Is Blocked

- Most users can skip local Deno validation and continue with deployment verification.
- If you do want local validation, install Deno or add it to `PATH`.
- Then re-run `deno check index.ts` and `deno fmt --check index.ts`.

## Expected Outcome

After setup, your Open Brain agent should be able to answer questions like:

- What maintenance is due in the next 30 days or 3,000 miles?
- What was the last oil change mileage?
- Which dealer recommendations are urgent versus probably oversold?
- What should I watch on this turbo direct-injection engine?
- What should I check before winter or before a highway trip?
- What does my timeline look like from current mileage to 150,000 miles?