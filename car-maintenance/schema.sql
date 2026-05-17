-- Car Maintenance Tracker
-- Vehicle-aware maintenance scheduling, service history, timelines, watch lists, and checklists.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS vehicles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  year INTEGER,
  make TEXT,
  model TEXT,
  trim TEXT,
  engine TEXT,
  vin TEXT,
  license_plate TEXT,
  current_mileage INTEGER NOT NULL DEFAULT 0,
  mileage_as_of DATE,
  annual_miles_min INTEGER,
  annual_miles_max INTEGER,
  annual_miles_estimate INTEGER,
  climate_notes TEXT,
  driving_notes TEXT,
  reliability_goal TEXT,
  tire_installed_at_mileage INTEGER,
  tire_warranty_miles INTEGER,
  tire_details TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vehicle_maintenance_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  interval_miles INTEGER,
  interval_days INTEGER,
  seasonal_months INTEGER[],
  priority TEXT CHECK (priority IN ('low', 'medium', 'high', 'urgent')) DEFAULT 'medium',
  status TEXT CHECK (status IN ('active', 'paused', 'completed', 'archived')) DEFAULT 'active',
  last_completed_at TIMESTAMPTZ,
  last_completed_mileage INTEGER,
  next_due_at TIMESTAMPTZ,
  next_due_mileage INTEGER,
  estimated_diy_cost_min DECIMAL(10, 2),
  estimated_diy_cost_max DECIMAL(10, 2),
  estimated_shop_cost_min DECIMAL(10, 2),
  estimated_shop_cost_max DECIMAL(10, 2),
  recommended_parts_or_fluids TEXT,
  oversell_risk BOOLEAN NOT NULL DEFAULT false,
  oversell_notes TEXT,
  watch_tags TEXT[],
  source TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vehicle_maintenance_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  task_id UUID REFERENCES vehicle_maintenance_tasks(id) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  mileage INTEGER NOT NULL,
  performed_by TEXT,
  vendor_name TEXT,
  cost DECIMAL(10, 2),
  service_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  parts_fluids JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes TEXT,
  next_action TEXT,
  source TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vehicle_timeline_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  task_id UUID REFERENCES vehicle_maintenance_tasks(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  category TEXT,
  item_type TEXT CHECK (item_type IN ('projected', 'one_time', 'dealer_reference', 'seasonal', 'watch')) DEFAULT 'projected',
  target_mileage INTEGER,
  target_date DATE,
  priority TEXT CHECK (priority IN ('low', 'medium', 'high', 'urgent')) DEFAULT 'medium',
  status TEXT CHECK (status IN ('pending', 'completed', 'skipped', 'archived')) DEFAULT 'pending',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vehicle_watch_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  priority TEXT CHECK (priority IN ('low', 'medium', 'high', 'urgent')) DEFAULT 'medium',
  symptoms TEXT,
  monitoring_notes TEXT,
  action_threshold TEXT,
  related_task_names TEXT[],
  status TEXT CHECK (status IN ('active', 'resolved', 'archived')) DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vehicle_checklists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  vehicle_id UUID REFERENCES vehicles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  checklist_type TEXT CHECK (checklist_type IN ('yearly', 'pre_winter', 'highway_trip', 'custom')) NOT NULL,
  cadence_days INTEGER,
  seasonal_months INTEGER[],
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vehicle_checklist_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  checklist_id UUID NOT NULL REFERENCES vehicle_checklists(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  category TEXT,
  priority TEXT CHECK (priority IN ('low', 'medium', 'high', 'urgent')) DEFAULT 'medium',
  sort_order INTEGER DEFAULT 0,
  notes TEXT,
  default_checked BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vehicles_user ON vehicles(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_vehicles_user_name ON vehicles(user_id, name);
CREATE INDEX IF NOT EXISTS idx_vehicle_tasks_user_vehicle ON vehicle_maintenance_tasks(user_id, vehicle_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_vehicle_tasks_user_vehicle_name ON vehicle_maintenance_tasks(user_id, vehicle_id, name);
CREATE INDEX IF NOT EXISTS idx_vehicle_tasks_user_next_due_at ON vehicle_maintenance_tasks(user_id, next_due_at);
CREATE INDEX IF NOT EXISTS idx_vehicle_tasks_user_next_due_mileage ON vehicle_maintenance_tasks(user_id, next_due_mileage);
CREATE INDEX IF NOT EXISTS idx_vehicle_tasks_vehicle_category ON vehicle_maintenance_tasks(vehicle_id, category);
CREATE INDEX IF NOT EXISTS idx_vehicle_logs_user_vehicle_completed ON vehicle_maintenance_logs(user_id, vehicle_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_vehicle_logs_vehicle_mileage ON vehicle_maintenance_logs(vehicle_id, mileage DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ux_vehicle_logs_user_vehicle_dedupe
  ON vehicle_maintenance_logs(user_id, vehicle_id, ((metadata->>'import_dedupe_key')))
  WHERE metadata ? 'import_dedupe_key';
CREATE INDEX IF NOT EXISTS idx_vehicle_timeline_vehicle_mileage ON vehicle_timeline_items(user_id, vehicle_id, target_mileage);
CREATE INDEX IF NOT EXISTS idx_vehicle_timeline_vehicle_date ON vehicle_timeline_items(user_id, vehicle_id, target_date);
CREATE INDEX IF NOT EXISTS idx_vehicle_watch_vehicle_status ON vehicle_watch_items(user_id, vehicle_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS ux_vehicle_watch_user_vehicle_topic ON vehicle_watch_items(user_id, vehicle_id, topic);
CREATE INDEX IF NOT EXISTS idx_vehicle_checklists_type ON vehicle_checklists(user_id, vehicle_id, checklist_type);
CREATE UNIQUE INDEX IF NOT EXISTS ux_vehicle_checklists_user_vehicle_type_name ON vehicle_checklists(user_id, vehicle_id, checklist_type, name);
CREATE UNIQUE INDEX IF NOT EXISTS ux_vehicle_checklist_items_user_checklist_label ON vehicle_checklist_items(user_id, checklist_id, label);

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vehicles_updated_at ON vehicles;
CREATE TRIGGER vehicles_updated_at
  BEFORE UPDATE ON vehicles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS vehicle_tasks_updated_at ON vehicle_maintenance_tasks;
CREATE TRIGGER vehicle_tasks_updated_at
  BEFORE UPDATE ON vehicle_maintenance_tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS vehicle_logs_updated_at ON vehicle_maintenance_logs;
CREATE TRIGGER vehicle_logs_updated_at
  BEFORE UPDATE ON vehicle_maintenance_logs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS vehicle_timeline_updated_at ON vehicle_timeline_items;
CREATE TRIGGER vehicle_timeline_updated_at
  BEFORE UPDATE ON vehicle_timeline_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS vehicle_watch_updated_at ON vehicle_watch_items;
CREATE TRIGGER vehicle_watch_updated_at
  BEFORE UPDATE ON vehicle_watch_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS vehicle_checklists_updated_at ON vehicle_checklists;
CREATE TRIGGER vehicle_checklists_updated_at
  BEFORE UPDATE ON vehicle_checklists
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS vehicle_checklist_items_updated_at ON vehicle_checklist_items;
CREATE TRIGGER vehicle_checklist_items_updated_at
  BEFORE UPDATE ON vehicle_checklist_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE FUNCTION estimate_vehicle_due_at(
  p_vehicle_id UUID,
  p_from_mileage INTEGER,
  p_target_mileage INTEGER,
  p_from_at TIMESTAMPTZ DEFAULT now()
)
RETURNS TIMESTAMPTZ AS $$
DECLARE
  annual_miles INTEGER;
  miles_delta INTEGER;
  days_delta NUMERIC;
BEGIN
  SELECT COALESCE(NULLIF(annual_miles_estimate, 0), 13500)
  INTO annual_miles
  FROM vehicles
  WHERE id = p_vehicle_id;

  annual_miles := COALESCE(NULLIF(annual_miles, 0), 13500);

  IF p_from_mileage IS NULL OR p_target_mileage IS NULL THEN
    RETURN NULL;
  END IF;

  miles_delta := p_target_mileage - p_from_mileage;

  IF miles_delta <= 0 THEN
    RETURN p_from_at;
  END IF;

  days_delta := (miles_delta::numeric / annual_miles::numeric) * 365.25;
  RETURN p_from_at + (days_delta || ' days')::interval;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION update_task_after_vehicle_maintenance_log()
RETURNS TRIGGER AS $$
DECLARE
  task_interval_miles INTEGER;
  task_interval_days INTEGER;
  calculated_next_mileage INTEGER;
  calculated_next_at TIMESTAMPTZ;
BEGIN
  IF NEW.task_id IS NOT NULL THEN
    SELECT interval_miles, interval_days
    INTO task_interval_miles, task_interval_days
    FROM vehicle_maintenance_tasks
    WHERE id = NEW.task_id;

    IF task_interval_miles IS NOT NULL THEN
      calculated_next_mileage := NEW.mileage + task_interval_miles;
    END IF;

    IF task_interval_days IS NOT NULL THEN
      calculated_next_at := NEW.completed_at + make_interval(days => task_interval_days);
    ELSIF calculated_next_mileage IS NOT NULL THEN
      calculated_next_at := estimate_vehicle_due_at(
        NEW.vehicle_id,
        NEW.mileage,
        calculated_next_mileage,
        NEW.completed_at
      );
    END IF;

    UPDATE vehicle_maintenance_tasks
    SET
      last_completed_at = NEW.completed_at,
      last_completed_mileage = NEW.mileage,
      next_due_mileage = COALESCE(calculated_next_mileage, next_due_mileage),
      next_due_at = COALESCE(calculated_next_at, next_due_at),
      updated_at = now()
    WHERE id = NEW.task_id;
  END IF;

  UPDATE vehicles
  SET
    current_mileage = GREATEST(current_mileage, NEW.mileage),
    mileage_as_of = CASE
      WHEN NEW.completed_at IS NULL THEN mileage_as_of
      WHEN NEW.mileage > current_mileage THEN NEW.completed_at::date
      WHEN NEW.mileage = current_mileage AND (
        mileage_as_of IS NULL OR NEW.completed_at::date > mileage_as_of
      ) THEN NEW.completed_at::date
      ELSE mileage_as_of
    END,
    updated_at = now()
  WHERE id = NEW.vehicle_id
    AND NEW.mileage >= current_mileage;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vehicle_log_updates_task ON vehicle_maintenance_logs;
CREATE TRIGGER vehicle_log_updates_task
  AFTER INSERT OR UPDATE ON vehicle_maintenance_logs
  FOR EACH ROW EXECUTE FUNCTION update_task_after_vehicle_maintenance_log();

ALTER TABLE vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_maintenance_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_maintenance_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_timeline_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_watch_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_checklists ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_checklist_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access" ON vehicles;
CREATE POLICY "Service role full access"
  ON vehicles FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role full access" ON vehicle_maintenance_tasks;
CREATE POLICY "Service role full access"
  ON vehicle_maintenance_tasks FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role full access" ON vehicle_maintenance_logs;
CREATE POLICY "Service role full access"
  ON vehicle_maintenance_logs FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role full access" ON vehicle_timeline_items;
CREATE POLICY "Service role full access"
  ON vehicle_timeline_items FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role full access" ON vehicle_watch_items;
CREATE POLICY "Service role full access"
  ON vehicle_watch_items FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role full access" ON vehicle_checklists;
CREATE POLICY "Service role full access"
  ON vehicle_checklists FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role full access" ON vehicle_checklist_items;
CREATE POLICY "Service role full access"
  ON vehicle_checklist_items FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
