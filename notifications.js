/* Keep Club notification transport.
 *
 * Achievement rules and copy belong to the achievement engine. This small
 * classic-script API owns only browser permission, the learner's opt-in, and
 * safe delivery through the installed service worker.
 *
 * There is deliberately no reminder scheduler here. A static, local-first PWA
 * cannot honestly promise a notification after the browser has suspended it;
 * that would require a push service. Achievements that arrive while the app is
 * hidden can still use the system notification surface, while a visible app
 * should celebrate in its own UI instead.
 */
(function (root) {
  'use strict';

  const KEY = 'keepclub/notifications/v1';
  const TAG_PREFIX = 'keepclub-achievement-';
  const shown = new Set();
  const inFlight = new Map();

  function supported() {
    return !!(root.Notification && root.navigator
      && root.navigator.serviceWorker
      && typeof root.navigator.serviceWorker.getRegistration === 'function');
  }

  function permission() {
    return supported() ? root.Notification.permission : 'unsupported';
  }

  function readPreference() {
    try {
      const saved = JSON.parse(root.localStorage.getItem(KEY) || 'null');
      return !!(saved && saved.enabled === true);
    } catch (e) {
      return false;
    }
  }

  function writePreference(enabled) {
    try {
      root.localStorage.setItem(KEY, JSON.stringify({
        v: 1,
        enabled: enabled === true,
      }));
      return true;
    } catch (e) {
      return false;
    }
  }

  function status(reason) {
    const preference = readPreference();
    const state = {
      supported: supported(),
      permission: permission(),
      preference,
      enabled: preference && permission() === 'granted',
    };
    if (reason) state.reason = reason;
    return state;
  }

  function gestureActive() {
    const activation = root.navigator && root.navigator.userActivation;
    // Older browsers do not expose UserActivation; requestPermission remains
    // the source of truth there and applies its own user-gesture policy.
    return !activation || activation.isActive === true;
  }

  async function requestPermission() {
    if (!supported()) return status('unsupported');
    if (permission() === 'granted') return status('granted');
    if (permission() === 'denied') return status('denied');
    if (!gestureActive()) return status('user-gesture-required');

    try {
      const result = await root.Notification.requestPermission();
      return status(result === 'granted' ? 'granted' : result || 'dismissed');
    } catch (e) {
      return status('request-failed');
    }
  }

  async function enable() {
    const result = await requestPermission();
    const enabled = result.permission === 'granted';
    if (!writePreference(enabled)) return status('storage-unavailable');
    return status(enabled ? 'enabled' : result.reason);
  }

  function disable() {
    return writePreference(false)
      ? status('disabled')
      : status('storage-unavailable');
  }

  function cleanText(value, max) {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function achievementId(value) {
    if (typeof value !== 'string') return '';
    const id = value.trim().toLowerCase();
    return /^[a-z0-9][a-z0-9_.:-]{0,79}$/.test(id) ? id : '';
  }

  function safeTarget(value, scope) {
    try {
      const base = new URL(scope);
      const target = new URL(typeof value === 'string' ? value : './', base);
      if (target.origin !== base.origin
          || !target.pathname.startsWith(base.pathname)) return base.href;
      return target.href;
    } catch (e) {
      return scope;
    }
  }

  async function deliver(item) {
    if (!supported()) return { shown: false, reason: 'unsupported' };
    if (!readPreference()) return { shown: false, reason: 'disabled' };
    if (permission() !== 'granted') return { shown: false, reason: 'permission' };
    // Toasts and share cards are clearer while the learner is looking at the
    // app. Avoid echoing the same achievement through the operating system.
    if (!root.document || root.document.hidden !== true) {
      return { shown: false, reason: 'foreground' };
    }

    const id = achievementId(item && item.id);
    const title = cleanText(item && item.title, 80);
    const body = cleanText(item && item.body, 180);
    if (!id || !title || !body) return { shown: false, reason: 'invalid' };
    if (shown.has(id)) return { shown: false, reason: 'duplicate' };

    let registration;
    try {
      registration = await root.navigator.serviceWorker.getRegistration();
    } catch (e) {
      return { shown: false, reason: 'worker-unavailable' };
    }
    if (!registration || typeof registration.showNotification !== 'function') {
      return { shown: false, reason: 'worker-unavailable' };
    }

    const url = safeTarget(item.url, registration.scope);
    const icon = new URL('icon-192.png', registration.scope).href;
    try {
      await registration.showNotification(title, {
        body,
        tag: TAG_PREFIX + id,
        renotify: false,
        icon,
        badge: icon,
        data: {
          kind: 'achievement',
          achievement: id,
          url,
        },
      });
      shown.add(id);
      return { shown: true, reason: 'shown' };
    } catch (e) {
      return { shown: false, reason: 'show-failed' };
    }
  }

  function notifyAchievement(item) {
    const id = achievementId(item && item.id);
    if (!id) return Promise.resolve({ shown: false, reason: 'invalid' });
    if (inFlight.has(id)) return inFlight.get(id);
    const pending = deliver(item).finally(() => inFlight.delete(id));
    inFlight.set(id, pending);
    return pending;
  }

  root.KeepNotifications = Object.freeze({
    KEY,
    supported,
    permission,
    status,
    requestPermission,
    enable,
    disable,
    notifyAchievement,
  });
}(globalThis));
