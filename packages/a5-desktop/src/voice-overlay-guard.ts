import type { Store } from './store.ts';
import type { Clock } from './clock.ts';

type Runner = (file: string, args: string[]) => Promise<string>;

/** 只约束已确认抢焦点的语音悬浮窗；不按共享 system UID 限制其他系统包。 */
export class VoiceOverlayGuard {
  private readonly store: Store;
  private readonly serial: string;
  private readonly adb: string;
  private readonly run: Runner;
  private readonly clock: Clock;
  private readonly audit: (action: string, detail: unknown) => void;
  private checkedAt = -Infinity;
  private value = { state: 'pending', package_name: 'com.rayneo.aispeech', checked_at: null as string | null, error: null as string | null };

  /** 绑定设备级权限备份、ADB 执行器和审计回调。 */
  constructor(store: Store, options: { serial: string; adb: string; run: Runner; clock: Clock; audit: (action: string, detail: unknown) => void }) {
    this.store = store; this.serial = options.serial; this.adb = options.adb; this.run = options.run; this.clock = options.clock; this.audit = options.audit;
  }
  /** 将权限备份按设备序列号隔离，防止跨设备恢复。 */
  private key() { return `device_voice_overlay_backup:${this.serial}`; }
  /** 读取持久化的原权限；解析失败交给调用边界处理。 */
  private backup() { return this.store.setting<{ mode: string } | null>(this.key()); }
  /** 无法读取备份时保留恢复责任，交由限频后的 sync 记录错误而不猜测权限。 */
  hasBackup() {
    try { return !!this.backup(); }
    catch { return true; }
  }
  /** 开启时每三十秒核对，关闭后持续尝试恢复尚存的备份。 */
  due(enabled: boolean) { return enabled ? this.clock.mono() - this.checkedAt >= 30000 : this.hasBackup(); }
  /** 返回最近一次权限核对的结果快照。 */
  status() { return { ...this.value }; }
  /** 读取目标包的悬浮窗 AppOps 模式，无法确认时拒绝猜测。 */
  private async mode() {
    const output = await this.run(this.adb, ['-s', this.serial, 'shell', 'cmd', 'appops', 'get', '--user', '0', this.value.package_name, 'SYSTEM_ALERT_WINDOW']);
    const match = /(?:SYSTEM_ALERT_WINDOW|android:system_alert_window):\s*(allow|ignore|deny|default|foreground)\b/.exec(output);
    if (match) return match[1]!;
    if (/No operations\./.test(output)) return 'default';
    throw new Error('无法读取语音助手悬浮窗权限；未修改系统配置。');
  }
  /** 先备份再设置并读回确认；恢复成功后才清除原权限备份。 */
  async sync(enabled: boolean) {
    this.checkedAt = this.clock.mono(); this.value.checked_at = new Date(this.clock.wall()).toISOString();
    try {
      const backup = this.backup();
      if (!enabled && !backup) { this.value.state = 'restored'; this.value.error = null; return; }
      const current = await this.mode();
      const target = enabled ? 'ignore' : backup!.mode;
      if (!['allow', 'ignore', 'deny', 'default', 'foreground'].includes(target)) throw new Error('语音助手权限备份无效，未修改系统配置。');
      // 先持久化原设置，断电后仍能恢复。备份不会被后续的 ignore 值覆盖。
      if (enabled && !backup) this.store.setSetting(this.key(), { mode: current });
      if (current !== target) {
        await this.run(this.adb, ['-s', this.serial, 'shell', 'cmd', 'appops', 'set', '--user', '0', this.value.package_name, 'SYSTEM_ALERT_WINDOW', target]);
        if (await this.mode() !== target) throw new Error('语音助手悬浮窗限制未生效，请检查 ADB 权限。');
        this.audit('voice_overlay', { restricted: enabled, previous_mode: current, mode: target });
      }
      if (!enabled) this.store.setSetting(this.key(), null);
      this.value.state = enabled ? 'protected' : 'restored'; this.value.error = null;
    } catch (error) {
      this.value.state = 'error';
      this.value.error = (error instanceof Error ? error.message : String(error)).replaceAll(this.serial, '[已绑定设备]');
      this.audit('voice_overlay', { ok: false, error: this.value.error });
    }
  }
}
