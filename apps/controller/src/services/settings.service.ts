import { Collections, SETTINGS_DOCUMENT_ID } from '@/constants/collections';
import { AuditAction } from '@/constants/enums';
import type { IDatastore, IRepository } from '@/interfaces/repository.port';
import { diffFields } from '@/models/auditLog.model';
import {
  defaultSettings,
  type Settings,
  type UpdateSettingsPayload,
} from '@/models/settings.model';
import type { ActorContext } from '@/types/common';
import { createLogger } from '@/utils/logger';
import type { AuditService } from './audit.service';

const log = createLogger('settings');

/**
 * Platform settings.
 *
 * A single document, seeded on first read. Cached in memory because the dashboard reads it
 * on every page load and it changes a handful of times a year.
 *
 * `autoArbitrationEnabled` and `maintenanceMode` are pushed into the live control loop via
 * the container's `autoArbitration` switch, so toggling maintenance mode takes effect on
 * the very next tick rather than at the next deployment.
 */
export class SettingsService {
  private readonly repo: IRepository<Settings>;
  private cache: Settings | null = null;

  constructor(
    datastore: IDatastore,
    private readonly audit: AuditService,
    /** Live control-loop switch, mutated when settings change. */
    private readonly autoArbitration: { enabled: boolean },
  ) {
    this.repo = datastore.repository<Settings>(Collections.SETTINGS);
  }

  async get(): Promise<Settings> {
    return this.cache ?? this.load();
  }

  /**
   * Read the singleton from the datastore, seeding it if absent.
   *
   * Settings is the one document the platform guarantees always exists — the dashboard
   * cannot render without a theme and a poll interval. Seeding on read rather than at
   * install time means a deployment whose settings document is missing (a restore from a
   * partial backup, a mis-scoped delete) self-heals instead of returning 404 to every
   * client.
   */
  private async load(): Promise<Settings> {
    const existing = await this.repo.findById(SETTINGS_DOCUMENT_ID);
    if (existing) {
      this.cache = existing;
      return existing;
    }

    const seeded = await this.repo.create({ ...defaultSettings(), id: SETTINGS_DOCUMENT_ID });
    log.info('seeded default platform settings');
    this.cache = seeded;
    return seeded;
  }

  async update(payload: UpdateSettingsPayload, actor: ActorContext): Promise<Settings> {
    // `load()` rather than `get()`: a cached copy proves nothing about the document still
    // being present, and updating against a stale cache fails with a confusing 404.
    const current = await this.load();

    // Nested objects are merged rather than replaced: a patch touching only
    // `dashboard.defaultTheme` must not silently reset the poll interval. Destructuring the
    // nested groups out first keeps their partial types from leaking through the spread
    // into fields the entity declares as complete.
    const { dashboard, notifications, ...scalars } = payload;

    const merged = await this.repo.update(
      SETTINGS_DOCUMENT_ID,
      {
        ...scalars,
        ...(dashboard ? { dashboard: { ...current.dashboard, ...dashboard } } : {}),
        ...(notifications
          ? { notifications: { ...current.notifications, ...notifications } }
          : {}),
      },
      { actor, expectedVersion: current.version },
    );

    this.cache = merged;
    this.syncControlLoop(merged);

    await this.audit.record({
      action: AuditAction.SETTINGS_UPDATED,
      actor,
      summary: describeChange(payload),
      target: { type: 'Settings', id: SETTINGS_DOCUMENT_ID },
      changes: diffFields(
        current as unknown as Record<string, unknown>,
        payload as Record<string, unknown>,
      ),
    });

    log.warn({ by: actor.userId, fields: Object.keys(payload) }, 'platform settings changed');
    return merged;
  }

  /** Apply operational settings to the running control loop. */
  private syncControlLoop(settings: Settings): void {
    const shouldArbitrate = settings.autoArbitrationEnabled && !settings.maintenanceMode;

    if (this.autoArbitration.enabled !== shouldArbitrate) {
      this.autoArbitration.enabled = shouldArbitrate;
      log.warn(
        { autoArbitration: shouldArbitrate, maintenanceMode: settings.maintenanceMode },
        shouldArbitrate
          ? 'AUTOMATIC ARBITRATION ENABLED — the platform will act on contention without human involvement'
          : 'AUTOMATIC ARBITRATION SUSPENDED — contention will be detected but not acted upon',
      );
    }
  }

  /** Called at boot so persisted settings govern the loop from the first tick. */
  async initialise(): Promise<void> {
    this.syncControlLoop(await this.get());
  }

  invalidateCache(): void {
    this.cache = null;
  }
}

function describeChange(payload: UpdateSettingsPayload): string {
  const parts: string[] = [];

  if (payload.autoArbitrationEnabled !== undefined) {
    parts.push(
      payload.autoArbitrationEnabled
        ? 'automatic arbitration ENABLED'
        : 'automatic arbitration SUSPENDED',
    );
  }
  if (payload.maintenanceMode !== undefined) {
    parts.push(payload.maintenanceMode ? 'maintenance mode ON' : 'maintenance mode OFF');
  }
  if (payload.notifications) parts.push('notification channels changed');
  if (payload.dashboard) parts.push('dashboard preferences changed');
  if (payload.organisationName) parts.push('organisation name changed');
  if (payload.currencyCode || payload.currencySymbol) parts.push('currency changed');

  return parts.length > 0 ? `Settings updated: ${parts.join(', ')}` : 'Settings updated';
}
