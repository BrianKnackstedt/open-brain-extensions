# Car Maintenance Starter Prompt

This is a disposable bootstrap prompt. Copy it, fill in the bracketed placeholders, run it once in Open Brain to create a starter maintenance plan for a vehicle, and then keep or delete the file as you prefer.

## Prompt

Create a complete vehicle maintenance starter plan for my car and store it in Open Brain.

If the new `car-maintenance` extension tools are available, use them first. Prefer structured vehicle, mileage, task, service-log, timeline, watch-list, and checklist fields.

If only the older `home-maintenance` extension is available, use its recurring task and maintenance-log tools as a fallback. In that case, store mileage intervals, next due mileage, estimated DIY cost, estimated shop cost, vehicle metadata, and oversell notes inside task notes. If mileage-based recurrence is not supported, create separate one-time milestone reminders for major mileage events.

Do not invent completed service history beyond the exact maintenance entries I provide below.

If an exact factory interval is unknown, keep the task conservative, label it as needing owner-manual or service-information confirmation, and avoid presenting guesses as confirmed OEM guidance.

## Planning Baseline

Current date: [YYYY-MM-DD]
Current mileage: [CURRENT_MILEAGE]
Date estimate rule: use [ANNUAL_MILES_ESTIMATE] miles/year as the midpoint for projected due dates while preserving an annual driving range of [ANNUAL_MILES_MIN]-[ANNUAL_MILES_MAX] miles/year.
Mileage is authoritative; projected dates are planning estimates.

## Vehicle

- [YEAR MAKE MODEL TRIM]
- Engine / drivetrain: [ENGINE OR DRIVETRAIN]
- Current mileage: [CURRENT_MILEAGE]
- Driving: [ANNUAL MILES AND GENERAL DRIVING MIX]
- Climate: [CLIMATE / REGION]
- Driving condition notes: [CITY, HIGHWAY, TOWING, SHORT TRIPS, WINTER, DUST, POTHOLES, ETC.]
- Goal: [RELIABILITY / COST / LONGEVITY / MINIMAL UPSELLS / WARRANTY TRACKING]

## Recent Maintenance History

Create completed maintenance logs for these exact entries only.

Repeat this block for each real completed service entry I provide:

### [DATE] at [MILEAGE] miles

- [SERVICE ITEM 1]
- [SERVICE ITEM 2]
- Vendor / shop: [OPTIONAL]
- Cost: [OPTIONAL]
- Parts / fluids / brand / spec: [OPTIONAL]
- Notes: [TRACKING NOTES, WARRANTY BASELINE, OR SPECIAL CONTEXT]

If I leave this section empty, do not create any completed logs.

## Current Flags, Recommendations, And Shop Feedback

Create high-priority current tasks or reminders for any items I flag as due now, overdue, recently recommended, or worth verifying.

- Current concerns: [ALIGNMENT / BRAKE FLUID / BATTERY / TIRES / SPARK PLUGS / TRANSMISSION / OTHER]
- Timing notes: [ASAP / SOON / OVERDUE / MONITOR ONLY]
- Shop or dealer recommendations to evaluate: [OPTIONAL]
- Service-specific caution notes: [OPTIONAL]

If a shop recommendation looks oversold or unsupported, keep the caution in the task notes rather than approving it automatically.

## Required Task Fields

For every recurring maintenance task, track these fields when the tool or schema supports them:

- Recommended mileage interval
- Time interval
- Priority level
- Notes explaining why the service matters
- Last completed date placeholder or known value
- Last completed mileage placeholder or known value
- Next due mileage
- Next due date estimate
- Estimated DIY cost
- Estimated shop cost
- Recommended parts, fluids, specs, or tracking notes
- Oversell risk flag and oversell notes when relevant

When a field is unavailable in the installed extension, include it in the task notes.

## Starter Maintenance Categories And Tasks

Create a practical starter plan using the vehicle details above, the recent maintenance history I provided, and broadly reasonable maintenance categories for this vehicle type.

Include the categories below when they apply. Omit irrelevant items, and mark any uncertain interval as needing manual confirmation.

### Engine / Fluids

Include as applicable:

1. Engine oil and filter
2. Transmission fluid service
3. Brake fluid exchange
4. Coolant service
5. Differential / transfer case / AWD fluid service
6. Power steering fluid if applicable

### Filters

Include as applicable:

1. Engine air filter
2. Cabin air filter
3. Fuel filter if separately serviceable

### Fuel / Ignition / Induction

Include as applicable:

1. Spark plugs
2. Fuel-system cleaner or intake-cleaning notes only when relevant to the engine type
3. Carbon-buildup monitoring for direct-injection engines when appropriate

### Brakes / Tires

Include as applicable:

1. Tire rotation
2. Wheel alignment when supported by symptoms, recent tire replacement, pothole impact, or known recommendation
3. Tire warranty tracking if relevant
4. Brake inspection follow-up notes

### Battery / Electrical

Include as applicable:

1. Battery health testing, especially before winter in cold climates
2. Charging-system check if relevant

### Suspension / Underbody / Seasonal

Include as applicable:

1. Underbody / rust inspection in salted-winter climates
2. Seasonal washer-fluid, wiper, or winter-prep reminders
3. Suspension or steering follow-up after vibration, pull, noise, or pothole impact

## Timeline Request

Generate an upcoming maintenance timeline from the current mileage through 150,000 miles.

Include:

- Immediate or overdue items from the current flags section
- Baseline completed items from the recent maintenance history I provided
- Recurring maintenance projections based on mileage, time, and seasonal relevance
- Any explicit one-time reminders or milestone notes that should remain visible

If I provide dealership or shop milestone recommendations, preserve them as annotated guidance, not automatic approval.

Add this note to dealer or shop reference milestones when relevant:

Reference milestones are guidance, not automatic approval for every recommended service. Use the maintenance plan, actual condition, owner-manual guidance, and evidence before approving upsell-prone work.

## Highlight High-Priority Services Likely Within The Next 12 Months

After building the plan, call out the likely high-priority items within the next 12 months based on current mileage, estimated annual mileage, climate, and the due or overdue items I provided.

## Services Commonly Oversold By Shops Or Dealerships

Flag oversell risks or caution notes when relevant, such as:

- Aggressive transmission flushes when a drain-and-fill is the more appropriate service
- Injector, induction, or fuel-system cleaning without symptoms, diagnostics, or a confirmed interval
- Cabin or engine air filter replacement long before the current filter is due
- Oil additives when correct oil and interval matter more
- Premature coolant flushes without age, mileage, condition, or manual justification
- Brake replacement without pad thickness, rotor measurements, symptoms, or corrosion evidence
- Alignment without pull, uneven wear, recent tire work, impact, or measurement evidence

Only apply oversell cautions that fit this vehicle and the evidence I provided.

## Watch List

Create a watch-list section with the most relevant active concerns for this vehicle.

Common examples include:

1. Tire wear
2. Brake fluid moisture contamination
3. Battery aging
4. Oil consumption or fluid leaks
5. Rust or underbody corrosion in salted climates
6. Turbo oil health for turbocharged vehicles
7. Carbon buildup for direct-injection engines

Only include watch items that fit the vehicle and climate.

## Yearly Ownership Summary Checklist

Create a yearly ownership checklist with practical annual review items such as:

- Review maintenance log and upcoming services
- Check recalls or service campaigns
- Verify oil and fluid cadence notes
- Review filters, tires, brakes, battery, coolant, lights, wipers, belts, hoses, suspension, and visible leaks
- Review insurance, registration, roadside assistance, and major receipts or warranty records

## Pre-Winter Checklist

If the vehicle lives in a cold-weather climate, create a pre-winter checklist with items such as:

- Tire tread depth and pressure
- Washer fluid and wipers
- Battery test
- Coolant freeze protection
- Brake-fluid status
- Lights, defrosters, and emergency kit
- Rust and underbody review

If winter prep is not relevant for the vehicle's climate, omit or replace this with a more appropriate seasonal checklist.

## Long Highway Trip Checklist

Create a long highway trip checklist with items such as:

- Tire pressure, tread, and visible damage
- Oil level and next oil due mileage
- Coolant level and warning lights
- Washer fluid and wipers
- Brake feel and brake noise
- Exterior lights
- Registration, insurance, roadside assistance, and emergency kit
- Confirm no unresolved urgent maintenance items

## Final Output Request

After creating the plan in Open Brain, summarize:

- Which vehicle record was created or updated
- How many recurring tasks were created
- How many completed maintenance logs were added
- Immediate high-priority next actions
- Upcoming maintenance in the next 30, 90, and 365 days
- Any tasks or intervals that still need owner-manual confirmation
- Any limitations caused by missing mileage-specific fields if the fallback home-maintenance extension was used