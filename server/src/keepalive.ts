/**
 * Самопинг против засыпания бесплатного инстанса.
 *
 * Бесплатный план Render останавливает контейнер после 15 минут без входящих
 * запросов, а холодный старт занимает около минуты — и первые секунды роутер
 * отвечает 502. Для демо-стенда, ссылку на который кто-то откроет в
 * непредсказуемый момент, это неприемлемо.
 *
 * Внешнее расписание эту задачу не решает: GitHub Actions на бесплатных
 * раннерах душит cron: запуски, заявленные как «каждые пять минут», на
 * практике приходят раз в 2–10 часов. Поэтому инстанс поддерживает себя сам: раз в N минут
 * ходит на собственный публичный адрес. Запрос уходит в интернет и
 * возвращается через роутер Render, то есть считается входящим и сбрасывает
 * таймер простоя.
 *
 * Разбудить уже уснувший контейнер самопинг не может — для этого остаётся
 * внешний workflow. Но до засыпания дело теперь доходить не должно.
 */

export interface KeepaliveOptions {
  /** Публичный адрес сервиса. На Render подставляется автоматически. */
  url: string;
  intervalMs: number;
  onLog?: (message: string) => void;
}

export interface KeepaliveHandle {
  stop: () => void;
}

export function startKeepalive(opts: KeepaliveOptions): KeepaliveHandle | null {
  const base = opts.url.replace(/\/+$/, '');
  if (!base || !/^https?:\/\//.test(base)) return null;

  const log = opts.onLog ?? (() => {});
  let consecutiveFailures = 0;

  const ping = async (): Promise<void> => {
    const started = Date.now();
    try {
      const res = await fetch(`${base}/api/health`, {
        headers: { 'user-agent': 'funnel-runtime-keepalive' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Молчим на успехе: иначе лог забьётся одинаковыми строками.
      if (consecutiveFailures > 0) {
        log(`keepalive восстановлен после ${consecutiveFailures} неудач (${Date.now() - started} мс)`);
        consecutiveFailures = 0;
      }
    } catch (err) {
      consecutiveFailures += 1;
      // Жалуемся не на каждую неудачу: сеть моргает, это нормально.
      if (consecutiveFailures === 1 || consecutiveFailures % 5 === 0) {
        log(`keepalive не прошёл (подряд ${consecutiveFailures}): ${(err as Error).message}`);
      }
    }
  };

  const timer = setInterval(() => void ping(), opts.intervalMs);
  // Таймер не должен держать процесс живым при остановке сервера.
  timer.unref?.();

  return { stop: () => clearInterval(timer) };
}
