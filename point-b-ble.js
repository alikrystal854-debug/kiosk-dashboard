/* Bluetooth LE transport for the Point B ESP32. Firmware-specific values live here. */
(() => {
  const DEVICE_NAME_PREFIX = 'ESP32';
  // Firmware edit point: copy the advertised GATT UUIDs from Point B here.
  const SERVICE_UUID = null;
  const DEVICE_TX_UUID = null; // Point B -> phone notifications
  const DEVICE_RX_UUID = null; // Phone -> Point B writes
  const DEVICE_STORAGE_KEY = 'campconnect-point-b-device-id';

  let device = null;
  let txCharacteristic = null;
  let rxCharacteristic = null;
  let nativeConnected = false;
  const nativeTransport = window.AndroidBluetooth && typeof window.AndroidBluetooth.requestDevice === 'function';

  function configured() {
    return Boolean(SERVICE_UUID && DEVICE_TX_UUID && DEVICE_RX_UUID);
  }

  function fire(name, detail = {}) {
    window.dispatchEvent(new CustomEvent(`campconnect-point-b:${name}`, { detail }));
  }

  function decodeNotification(event) {
    try {
      const bytes = new Uint8Array(event.target.value.buffer, event.target.value.byteOffset, event.target.value.byteLength);
      const text = new TextDecoder().decode(bytes).trim();
      const message = JSON.parse(text);
      if (message && message.v === 1 && typeof message.type === 'string') {
        fire('message', { message });
      }
    } catch (_) {
      fire('error', { message: 'Point B sent an invalid message. Check that both ESP32s use the documented protocol.' });
    }
  }

  function disconnected() {
    txCharacteristic = null;
    rxCharacteristic = null;
    const disconnectedDevice = device;
    device = null;
    nativeConnected = false;
    fire('disconnected', { device: disconnectedDevice });
  }

  function receiveJson(text) {
    try {
      const message = JSON.parse(text);
      if (message && message.v === 1 && typeof message.type === 'string') fire('message', { message });
      else throw new Error('invalid message');
    } catch (_) {
      fire('error', { message: 'Point B sent an invalid message. Check that both ESP32s use the documented protocol.' });
    }
  }

  if (nativeTransport) {
    window.CampConnectPointBNative = {
      onConnected(name) {
        nativeConnected = true;
        device = { name: name || 'Point B' };
        fire('connected', { device });
      },
      onDisconnected: disconnected,
      onMessage: receiveJson,
      onError(message) { fire('error', { message: message || 'Point B Bluetooth connection failed.' }); },
    };
  }

  async function connectDevice(selectedDevice) {
    if (!configured()) throw new Error('Point B GATT UUIDs are not set yet. Add the firmware UUIDs in phone campconnect/point-b-ble.js.');
    if (!selectedDevice?.gatt) throw new Error('The selected Point B device does not provide Bluetooth LE.');
    device = selectedDevice;
    device.addEventListener('gattserverdisconnected', disconnected, { once: true });
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    txCharacteristic = await service.getCharacteristic(DEVICE_TX_UUID);
    rxCharacteristic = await service.getCharacteristic(DEVICE_RX_UUID);
    await txCharacteristic.startNotifications();
    txCharacteristic.addEventListener('characteristicvaluechanged', decodeNotification);
    try { localStorage.setItem(DEVICE_STORAGE_KEY, device.id); } catch (_) { /* BLE can still be used for this page session. */ }
    fire('connected', { device });
    return device;
  }

  async function requestAndConnect() {
    if (!configured()) throw new Error('Point B GATT UUIDs are not set yet. Add the firmware UUIDs in phone campconnect/point-b-ble.js.');
    if (nativeTransport) {
      nativeConnected = false;
      window.AndroidBluetooth.requestDevice(DEVICE_NAME_PREFIX, SERVICE_UUID, DEVICE_TX_UUID, DEVICE_RX_UUID);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { cleanup(); reject(new Error('No Point B device was selected. Check that it is powered and advertising.')); }, 20000);
        const onConnected = event => { cleanup(); resolve(event.detail.device); };
        const onError = event => { cleanup(); reject(new Error(event.detail.message)); };
        function cleanup() {
          clearTimeout(timeout);
          window.removeEventListener('campconnect-point-b:connected', onConnected);
          window.removeEventListener('campconnect-point-b:error', onError);
        }
        window.addEventListener('campconnect-point-b:connected', onConnected, { once: true });
        window.addEventListener('campconnect-point-b:error', onError, { once: true });
      });
    }
    if (!window.isSecureContext || !navigator.bluetooth) {
      throw new Error('Bluetooth needs a supported browser and a secure HTTPS page.');
    }
    const selectedDevice = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: DEVICE_NAME_PREFIX, services: [SERVICE_UUID] }],
      optionalServices: [SERVICE_UUID],
    });
    return connectDevice(selectedDevice);
  }

  async function reconnectGranted() {
    if (nativeTransport) return null;
    if (!configured() || !navigator.bluetooth?.getDevices) return null;
    let savedId = null;
    try { savedId = localStorage.getItem(DEVICE_STORAGE_KEY); } catch (_) { return null; }
    if (!savedId) return null;
    const granted = await navigator.bluetooth.getDevices();
    const selectedDevice = granted.find(item => item.id === savedId
      && (!DEVICE_NAME_PREFIX || !item.name || item.name.startsWith(DEVICE_NAME_PREFIX)));
    return selectedDevice ? connectDevice(selectedDevice) : null;
  }

  async function send(message) {
    if (nativeTransport) {
      if (!nativeConnected) throw new Error('Point B is not connected over Bluetooth.');
      const accepted = window.AndroidBluetooth.sendMessage(JSON.stringify({ v: 1, ...message }));
      if (!accepted) throw new Error('Android could not write to Point B. Check the connection and try again.');
      return;
    }
    if (!device?.gatt?.connected || !rxCharacteristic) throw new Error('Point B is not connected over Bluetooth.');
    const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, ...message }));
    if (typeof rxCharacteristic.writeValueWithResponse === 'function') {
      await rxCharacteristic.writeValueWithResponse(bytes);
    } else {
      await rxCharacteristic.writeValue(bytes);
    }
  }

  window.CampConnectPointB = {
    get config() { return { deviceNamePrefix: DEVICE_NAME_PREFIX, serviceUuid: SERVICE_UUID, txUuid: DEVICE_TX_UUID, rxUuid: DEVICE_RX_UUID, configured: configured() }; },
    get connected() { return nativeTransport ? nativeConnected : Boolean(device?.gatt?.connected && txCharacteristic && rxCharacteristic); },
    requestAndConnect,
    connectDevice,
    reconnectGranted,
    send,
  };
})();
