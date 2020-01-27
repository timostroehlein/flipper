/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 */

import os from 'os';
import path from 'path';
import electron from 'electron';
import {getInstance as getLogger} from '../fb-stubs/Logger';
import {Store, State as ReduxState, MiddlewareAPI} from '../reducers';
import {DeviceExport} from '../devices/BaseDevice';
import {State as PluginStatesState} from '../reducers/pluginStates';
import {PluginNotification} from '../reducers/notifications';
import Client, {ClientExport, ClientQuery} from '../Client';
import {pluginKey} from '../reducers/pluginStates';
import {
  FlipperDevicePlugin,
  FlipperPlugin,
  callClient,
  FlipperBasePlugin,
} from '../plugin';
import {default as BaseDevice} from '../devices/BaseDevice';
import {default as ArchivedDevice} from '../devices/ArchivedDevice';
import fs from 'fs';
import uuid from 'uuid';
import {remote, OpenDialogOptions} from 'electron';
import {readCurrentRevision} from './packageMetadata';
import {tryCatchReportPlatformFailures} from './metrics';
import {promisify} from 'util';
import promiseTimeout from './promiseTimeout';
import {Idler} from './Idler';
import {setStaticView} from '../reducers/connections';
import {
  resetSupportFormV2State,
  SupportFormRequestDetailsState,
} from '../reducers/supportForm';
import {setSelectPluginsToExportActiveSheet} from '../reducers/application';
import {deconstructClientId, deconstructPluginKey} from '../utils/clientUtils';
import {performance} from 'perf_hooks';
import {processMessageQueue} from './messageQueue';
import {getPluginTitle} from './pluginUtils';

export const IMPORT_FLIPPER_TRACE_EVENT = 'import-flipper-trace';
export const EXPORT_FLIPPER_TRACE_EVENT = 'export-flipper-trace';
export const EXPORT_FLIPPER_TRACE_TIME_SERIALIZATION_EVENT = `${EXPORT_FLIPPER_TRACE_EVENT}:serialization`;

export type PluginStatesExportState = {
  [pluginKey: string]: string;
};
export type ExportType = {
  fileVersion: string;
  flipperReleaseRevision: string | undefined;
  clients: Array<ClientExport>;
  device: DeviceExport | null;
  store: {
    pluginStates: PluginStatesExportState;
    activeNotifications: Array<PluginNotification>;
  };
  supportRequestDetails?: SupportFormRequestDetailsState;
};

type ProcessPluginStatesOptions = {
  clients: Array<ClientExport>;
  serial: string;
  allPluginStates: PluginStatesState;
  devicePlugins: Map<string, typeof FlipperDevicePlugin>;
  selectedPlugins: Array<string>;
  statusUpdate?: (msg: string) => void;
};

type ProcessNotificationStatesOptions = {
  clients: Array<ClientExport>;
  serial: string;
  allActiveNotifications: Array<PluginNotification>;
  devicePlugins: Map<string, typeof FlipperDevicePlugin>;
  statusUpdate?: (msg: string) => void;
};

type SerializePluginStatesOptions = {
  pluginStates: PluginStatesState;
};

type PluginsToProcess = {
  pluginKey: string;
  pluginId: string;
  pluginName: string;
  pluginClass: typeof FlipperPlugin | typeof FlipperDevicePlugin;
  client: Client;
}[];

type AddSaltToDeviceSerialOptions = {
  salt: string;
  device: BaseDevice;
  clients: Array<ClientExport>;
  pluginStates: PluginStatesExportState;
  pluginNotification: Array<PluginNotification>;
  selectedPlugins: Array<string>;
  statusUpdate?: (msg: string) => void;
};

export function processClients(
  clients: Array<ClientExport>,
  serial: string,
  statusUpdate?: (msg: string) => void,
): Array<ClientExport> {
  statusUpdate &&
    statusUpdate(`Filtering Clients for the device id ${serial}...`);
  const filteredClients = clients.filter(
    client => client.query.device_id === serial,
  );
  return filteredClients;
}

export function processPluginStates(
  options: ProcessPluginStatesOptions,
): PluginStatesState {
  const {
    clients,
    serial,
    allPluginStates,
    devicePlugins,
    selectedPlugins,
    statusUpdate,
  } = options;

  let pluginStates: PluginStatesState = {};
  statusUpdate &&
    statusUpdate('Filtering the plugin states for the filtered Clients...');
  for (const key in allPluginStates) {
    const plugin = deconstructPluginKey(key);

    const pluginName = plugin.pluginName;
    if (
      pluginName &&
      selectedPlugins.length > 0 &&
      !selectedPlugins.includes(pluginName)
    ) {
      continue;
    }
    if (plugin.type === 'client') {
      if (!clients.some(c => c.id.includes(plugin.client))) {
        continue;
      }
    }
    if (plugin.type === 'device') {
      if (
        !pluginName ||
        !devicePlugins.has(pluginName) ||
        serial !== plugin.client
      ) {
        continue;
      }
    }
    pluginStates = {...pluginStates, [key]: allPluginStates[key]};
  }
  return pluginStates;
}

export function processNotificationStates(
  options: ProcessNotificationStatesOptions,
): Array<PluginNotification> {
  const {
    clients,
    serial,
    allActiveNotifications,
    devicePlugins,
    statusUpdate,
  } = options;
  statusUpdate &&
    statusUpdate('Filtering the notifications for the filtered Clients...');
  const activeNotifications = allActiveNotifications.filter(notif => {
    const filteredClients = clients.filter(client =>
      notif.client ? client.id.includes(notif.client) : false,
    );
    return (
      filteredClients.length > 0 ||
      (devicePlugins.has(notif.pluginId) && serial === notif.client)
    ); // There need not be any client for device Plugins
  });
  return activeNotifications;
}

const serializePluginStates = async (
  pluginStates: PluginStatesState,
  clientPlugins: Map<string, typeof FlipperPlugin>,
  devicePlugins: Map<string, typeof FlipperDevicePlugin>,
  statusUpdate?: (msg: string) => void,
  idler?: Idler,
): Promise<PluginStatesExportState> => {
  const pluginsMap: Map<string, typeof FlipperBasePlugin> = new Map([]);
  clientPlugins.forEach((val, key) => {
    pluginsMap.set(key, val);
  });
  devicePlugins.forEach((val, key) => {
    pluginsMap.set(key, val);
  });
  const pluginExportState: PluginStatesExportState = {};
  for (const key in pluginStates) {
    const pluginName = deconstructPluginKey(key).pluginName;
    statusUpdate && statusUpdate(`Serialising ${pluginName}...`);
    const serializationMarker = `${EXPORT_FLIPPER_TRACE_EVENT}:serialization-per-plugin`;
    performance.mark(serializationMarker);
    const pluginClass = pluginName ? pluginsMap.get(pluginName) : null;
    if (pluginClass) {
      pluginExportState[key] = await pluginClass.serializePersistedState(
        pluginStates[key],
        statusUpdate,
        idler,
        pluginName,
      );
      getLogger().trackTimeSince(serializationMarker, serializationMarker, {
        plugin: pluginName,
      });
    }
  }
  return pluginExportState;
};

const deserializePluginStates = (
  pluginStatesExportState: PluginStatesExportState,
  clientPlugins: Map<string, typeof FlipperPlugin>,
  devicePlugins: Map<string, typeof FlipperDevicePlugin>,
): PluginStatesState => {
  const pluginsMap: Map<string, typeof FlipperBasePlugin> = new Map([]);
  clientPlugins.forEach((val, key) => {
    pluginsMap.set(key, val);
  });
  devicePlugins.forEach((val, key) => {
    pluginsMap.set(key, val);
  });
  const pluginsState: PluginStatesState = {};
  for (const key in pluginStatesExportState) {
    const pluginName = deconstructPluginKey(key).pluginName;
    if (!pluginName || !pluginsMap.get(pluginName)) {
      continue;
    }
    const pluginClass = pluginsMap.get(pluginName);
    if (pluginClass) {
      pluginsState[key] = pluginClass.deserializePersistedState(
        pluginStatesExportState[key],
      );
    }
  }
  return pluginsState;
};

const addSaltToDeviceSerial = async (
  options: AddSaltToDeviceSerialOptions,
): Promise<ExportType> => {
  const {
    salt,
    device,
    clients,
    pluginStates,
    pluginNotification,
    statusUpdate,
    selectedPlugins,
  } = options;
  const {serial} = device;
  const newSerial = salt + '-' + serial;
  const newDevice = new ArchivedDevice(
    newSerial,
    device.deviceType,
    device.title,
    device.os,
    selectedPlugins.includes('DeviceLogs') ? device.getLogs() : [],
  );
  statusUpdate &&
    statusUpdate('Adding salt to the selected device id in the client data...');
  const updatedClients = clients.map((client: ClientExport) => {
    return {
      ...client,
      id: client.id.replace(serial, newSerial),
      query: {...client.query, device_id: newSerial},
    };
  });

  statusUpdate &&
    statusUpdate(
      'Adding salt to the selected device id in the plugin states...',
    );
  const updatedPluginStates: PluginStatesExportState = {};
  for (let key in pluginStates) {
    if (!key.includes(serial)) {
      throw new Error(
        `Error while exporting, plugin state (${key}) does not have ${serial} in its key`,
      );
    }
    const pluginData = pluginStates[key];
    key = key.replace(serial, newSerial);
    updatedPluginStates[key] = pluginData;
  }

  statusUpdate &&
    statusUpdate(
      'Adding salt to the selected device id in the notification data...',
    );
  const updatedPluginNotifications = pluginNotification.map(notif => {
    if (!notif.client || !notif.client.includes(serial)) {
      throw new Error(
        `Error while exporting, plugin state (${notif.pluginId}) does not have ${serial} in it`,
      );
    }
    return {...notif, client: notif.client.replace(serial, newSerial)};
  });
  const revision: string | undefined = await readCurrentRevision();
  return {
    fileVersion: remote.app.getVersion(),
    flipperReleaseRevision: revision,
    clients: updatedClients,
    device: newDevice.toJSON(),
    store: {
      pluginStates: updatedPluginStates,
      activeNotifications: updatedPluginNotifications,
    },
  };
};

type ProcessStoreOptions = {
  activeNotifications: Array<PluginNotification>;
  device: BaseDevice | null;
  pluginStates: PluginStatesState;
  clients: Array<ClientExport>;
  devicePlugins: Map<string, typeof FlipperDevicePlugin>;
  clientPlugins: Map<string, typeof FlipperPlugin>;
  salt: string;
  selectedPlugins: Array<string>;
  statusUpdate?: (msg: string) => void;
};

export const processStore = async (
  options: ProcessStoreOptions,
  idler?: Idler,
): Promise<ExportType | null> => {
  const {
    activeNotifications,
    device,
    pluginStates,
    clients,
    devicePlugins,
    clientPlugins,
    salt,
    selectedPlugins,
    statusUpdate,
  } = options;

  if (device) {
    const {serial} = device;
    const processedClients = processClients(clients, serial, statusUpdate);
    const processedPluginStates = processPluginStates({
      clients: processedClients,
      serial,
      allPluginStates: pluginStates,
      devicePlugins,
      selectedPlugins,
      statusUpdate,
    });
    const processedActiveNotifications = processNotificationStates({
      clients: processedClients,
      serial,
      allActiveNotifications: activeNotifications,
      devicePlugins,
      statusUpdate,
    });

    const exportPluginState = await serializePluginStates(
      processedPluginStates,
      clientPlugins,
      devicePlugins,
      statusUpdate,
      idler,
    );
    // Adding salt to the device id, so that the device_id in the device list is unique.
    const exportFlipperData = await addSaltToDeviceSerial({
      salt,
      device,
      clients: processedClients,
      pluginStates: exportPluginState,
      pluginNotification: processedActiveNotifications,
      statusUpdate,
      selectedPlugins,
    });

    return exportFlipperData;
  }
  return null;
};

export async function fetchMetadata(
  pluginsToProcess: PluginsToProcess,
  pluginStates: PluginStatesState,
  state: ReduxState,
  statusUpdate?: (msg: string) => void,
  idler?: Idler,
): Promise<{pluginStates: PluginStatesState; errorArray: Array<Error>}> {
  const newPluginState = {...pluginStates};
  const errorArray: Array<Error> = [];

  for (const {
    pluginName,
    pluginId,
    pluginClass,
    client,
    pluginKey,
  } of pluginsToProcess) {
    const exportState = pluginClass ? pluginClass.exportPersistedState : null;
    if (exportState) {
      const fetchMetaDataMarker = `${EXPORT_FLIPPER_TRACE_EVENT}:fetch-meta-data-per-plugin`;
      performance.mark(fetchMetaDataMarker);
      try {
        statusUpdate &&
          statusUpdate(`Fetching metadata for plugin ${pluginName}...`);
        const data = await promiseTimeout(
          240000, // Fetching MobileConfig data takes ~ 3 mins, thus keeping timeout at 4 mins.
          exportState(
            callClient(client, pluginId),
            newPluginState[pluginKey],
            state,
            idler,
            statusUpdate,
          ),
          `Timed out while collecting data for ${pluginName}`,
        );
        getLogger().trackTimeSince(fetchMetaDataMarker, fetchMetaDataMarker, {
          pluginId,
        });
        newPluginState[pluginKey] = data;
      } catch (e) {
        errorArray.push(e);
        getLogger().trackTimeSince(fetchMetaDataMarker, fetchMetaDataMarker, {
          pluginId,
          error: e,
        });
        continue;
      }
    }
  }

  return {pluginStates: newPluginState, errorArray};
}

async function processQueues(
  store: MiddlewareAPI,
  pluginsToProcess: PluginsToProcess,
  statusUpdate?: (msg: string) => void,
  idler?: Idler,
) {
  for (const {
    pluginName,
    pluginId,
    pluginKey,
    pluginClass,
  } of pluginsToProcess) {
    if (pluginClass.persistedStateReducer) {
      const processQueueMarker = `${EXPORT_FLIPPER_TRACE_EVENT}:process-queue-per-plugin`;
      performance.mark(processQueueMarker);

      await processMessageQueue(
        pluginClass,
        pluginKey,
        store,
        ({current, total}) => {
          statusUpdate?.(
            `Processing event ${current} / ${total} (${Math.round(
              (current / total) * 100,
            )}%) for plugin ${pluginName}`,
          );
        },
        idler,
      );

      getLogger().trackTimeSince(processQueueMarker, processQueueMarker, {
        pluginId,
      });
    }
  }
}

function getSelection(
  store: MiddlewareAPI,
): {client: Client | null; device: BaseDevice | null} {
  const state = store.getState();
  const {clients} = state.connections;
  const client = clients.find(
    client => client.id === state.connections.selectedApp,
  );
  const {selectedDevice} = state.connections;
  return {client: client ?? null, device: selectedDevice};
}

export function determinePluginsToProcess(
  store: MiddlewareAPI,
): PluginsToProcess {
  const state = store.getState();
  const {plugins} = state;
  const {clients} = state.connections;
  const {client, device} = getSelection(store);

  const pluginsToProcess: PluginsToProcess = [];
  const selectedPlugins = state.plugins.selectedPlugins;
  const selectedFilteredPlugins = client
    ? selectedPlugins.length > 0
      ? client.plugins.filter(plugin => selectedPlugins.includes(plugin))
      : client.plugins
    : [];
  for (const client of clients) {
    if (!device || device.isArchived || !client.id.includes(device.serial)) {
      continue;
    }
    for (const plugin of selectedFilteredPlugins) {
      const pluginClass =
        plugins.clientPlugins.get(plugin) || plugins.devicePlugins.get(plugin);
      if (pluginClass) {
        const key = pluginKey(client.id, plugin);
        pluginsToProcess.push({
          pluginKey: key,
          client,
          pluginId: plugin,
          pluginName: getPluginTitle(pluginClass),
          pluginClass,
        });
      }
    }
  }
  return pluginsToProcess;
}

export async function getStoreExport(
  store: MiddlewareAPI,
  statusUpdate?: (msg: string) => void,
  idler?: Idler,
): Promise<{exportData: ExportType | null; errorArray: Array<Error>}> {
  const pluginsToProcess = determinePluginsToProcess(store);

  statusUpdate?.('Preparing to process data queues for plugins...');
  await processQueues(store, pluginsToProcess, statusUpdate, idler);

  statusUpdate && statusUpdate('Preparing to fetch metadata from client...');
  const fetchMetaDataMarker = `${EXPORT_FLIPPER_TRACE_EVENT}:fetch-meta-data`;
  performance.mark(fetchMetaDataMarker);

  const {device, client} = getSelection(store);
  const state = store.getState();
  const metadata = await fetchMetadata(
    pluginsToProcess,
    state.pluginStates,
    state,
    statusUpdate,
    idler,
  );

  getLogger().trackTimeSince(fetchMetaDataMarker, fetchMetaDataMarker, {
    plugins: state.plugins.selectedPlugins,
  });
  const {errorArray} = metadata;
  const newPluginState = metadata.pluginStates;

  const {activeNotifications} = state.notifications;
  const {devicePlugins, clientPlugins} = state.plugins;
  const exportData = await processStore(
    {
      activeNotifications,
      device,
      pluginStates: newPluginState,
      clients: client ? [client.toJSON()] : [],
      devicePlugins,
      clientPlugins,
      salt: uuid.v4(),
      selectedPlugins: state.plugins.selectedPlugins,
      statusUpdate,
    },
    idler,
  );
  return {exportData, errorArray};
}

export async function exportStore(
  store: MiddlewareAPI,
  includeSupportDetails?: boolean,
  idler?: Idler,
  statusUpdate?: (msg: string) => void,
): Promise<{serializedString: string; errorArray: Array<Error>}> {
  getLogger().track('usage', EXPORT_FLIPPER_TRACE_EVENT);
  performance.mark(EXPORT_FLIPPER_TRACE_TIME_SERIALIZATION_EVENT);
  statusUpdate && statusUpdate('Preparing to export Flipper data...');
  const state = store.getState();
  const {exportData, errorArray} = await getStoreExport(
    store,
    statusUpdate,
    idler,
  );
  if (exportData != null) {
    if (includeSupportDetails) {
      exportData.supportRequestDetails = {
        ...state.supportForm?.supportFormV2,
        appName:
          state.connections.selectedApp == null
            ? ''
            : deconstructClientId(state.connections.selectedApp).app,
      };
    }

    statusUpdate && statusUpdate('Serializing Flipper data...');
    const serializedString = JSON.stringify(exportData);
    if (serializedString.length <= 0) {
      throw new Error('Serialize function returned empty string');
    }
    getLogger().trackTimeSince(
      EXPORT_FLIPPER_TRACE_TIME_SERIALIZATION_EVENT,
      EXPORT_FLIPPER_TRACE_TIME_SERIALIZATION_EVENT,
      {
        plugins: state.plugins.selectedPlugins,
      },
    );
    return {serializedString, errorArray};
  } else {
    return {serializedString: '{}', errorArray: []};
  }
}

export const exportStoreToFile = (
  exportFilePath: string,
  store: MiddlewareAPI,
  includeSupportDetails: boolean,
  idler?: Idler,
  statusUpdate?: (msg: string) => void,
): Promise<{errorArray: Array<Error>}> => {
  return exportStore(store, includeSupportDetails, idler, statusUpdate).then(
    ({serializedString, errorArray}) => {
      return promisify(fs.writeFile)(exportFilePath, serializedString).then(
        () => {
          store.dispatch(resetSupportFormV2State());
          return {errorArray};
        },
      );
    },
  );
};

export function importDataToStore(source: string, data: string, store: Store) {
  getLogger().track('usage', IMPORT_FLIPPER_TRACE_EVENT);
  const json: ExportType = JSON.parse(data);
  const {device, clients, supportRequestDetails} = json;
  if (device == null) {
    return;
  }
  const {serial, deviceType, title, os, logs} = device;
  const archivedDevice = new ArchivedDevice(
    serial,
    deviceType,
    title,
    os,
    logs
      ? logs.map(l => {
          return {...l, date: new Date(l.date)};
        })
      : [],
    source,
    supportRequestDetails,
  );
  const devices = store.getState().connections.devices;
  const matchedDevices = devices.filter(
    availableDevice => availableDevice.serial === serial,
  );
  if (matchedDevices.length > 0) {
    store.dispatch({
      type: 'SELECT_DEVICE',
      payload: matchedDevices[0],
    });
    return;
  }
  archivedDevice.loadDevicePlugins(store.getState().plugins.devicePlugins);
  store.dispatch({
    type: 'REGISTER_DEVICE',
    payload: archivedDevice,
  });
  store.dispatch({
    type: 'SELECT_DEVICE',
    payload: archivedDevice,
  });

  const {pluginStates} = json.store;
  const processedPluginStates: PluginStatesState = deserializePluginStates(
    pluginStates,
    store.getState().plugins.clientPlugins,
    store.getState().plugins.devicePlugins,
  );
  const keys = Object.keys(processedPluginStates);
  keys.forEach(key => {
    store.dispatch({
      type: 'SET_PLUGIN_STATE',
      payload: {
        pluginKey: key,
        state: processedPluginStates[key],
      },
    });
  });
  clients.forEach((client: {id: string; query: ClientQuery}) => {
    const clientPlugins: Array<string> = keys
      .filter(key => {
        const plugin = deconstructPluginKey(key);
        return plugin.type === 'client' && client.id === plugin.client;
      })
      .map(pluginKey => deconstructPluginKey(pluginKey).pluginName);
    store.dispatch({
      type: 'NEW_CLIENT',
      payload: new Client(
        client.id,
        client.query,
        null,
        getLogger(),
        store,
        clientPlugins,
        archivedDevice,
      ),
    });
  });
  if (supportRequestDetails) {
    store.dispatch(
      // Late require to avoid circular dependency issue
      setStaticView(require('../fb-stubs/SupportRequestDetails').default),
    );
  }
}

export const importFileToStore = (file: string, store: Store) => {
  fs.readFile(file, 'utf8', (err, data) => {
    if (err) {
      console.error(err);
      return;
    }
    importDataToStore(file, data, store);
  });
};

export function showOpenDialog(store: Store) {
  const options: OpenDialogOptions = {
    properties: ['openFile'],
    filters: [{extensions: ['flipper', 'json', 'txt'], name: 'Flipper files'}],
  };
  remote.dialog.showOpenDialog(options).then(result => {
    const filePaths = result.filePaths;
    if (filePaths.length > 0) {
      tryCatchReportPlatformFailures(() => {
        importFileToStore(filePaths[0], store);
      }, `${IMPORT_FLIPPER_TRACE_EVENT}:UI`);
    }
  });
}

export function startFileExport(dispatch: Store['dispatch']) {
  electron.remote.dialog
    .showSaveDialog(
      // @ts-ignore This appears to work but isn't allowed by the types
      null,
      {
        title: 'FlipperExport',
        defaultPath: path.join(os.homedir(), 'FlipperExport.flipper'),
      },
    )
    .then(async (result: electron.SaveDialogReturnValue) => {
      const file = result.filePath;
      if (!file) {
        return;
      }
      dispatch(
        setSelectPluginsToExportActiveSheet({
          type: 'file',
          file: file,
          closeOnFinish: false,
        }),
      );
    });
}

export function startLinkExport(dispatch: Store['dispatch']) {
  dispatch(
    setSelectPluginsToExportActiveSheet({
      type: 'link',
      closeOnFinish: false,
    }),
  );
}
