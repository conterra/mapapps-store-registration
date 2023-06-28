/*
 * Copyright (C) 2023 con terra GmbH (info@conterra.de)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *         http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import replace from "apprt-core/string-replace";
import LayerObserver from "map-widget/LayerObserver";
import Observers from "apprt-core/Observers";
import AsyncTask from "apprt-core/AsyncTask";
import { StoreInitializer } from "./StoreInitializer";
import { parseLayerPath } from "./util";

export function FilterStoreFactory() {
    let _registration;
    let _initializationPending;
    let _layerRemoved;
    let _changeTask;
    let _destroyed = false;
    const observers = Observers();

    function _unregisterStore() {
        observers.group("store").clean();
        observers.group("defQuery").clean();
        const reg = _registration;
        _registration = undefined;
        if (reg) {
            reg.unregister();
        }
    }

    return {
        activate() {
            const { layerId } = this._properties;
            if (layerId) {
                this._observeLayer(layerId);
                return;
            }
            this._initStore()
                .then(({ store, props }) => {
                    if (_destroyed) {
                        store?.destroy?.();
                        return;
                    }

                    this._register(store, props);
                })
                .catch((e) => {
                    console.warn(`[agssearch] Store '${this._properties.id}' could not be initialized. ${e}`);
                });
        },

        _initStore() {
            if (_initializationPending) {
                return _initializationPending;
            }
            const { defaults } = this._i18n.get();
            const initializer = StoreInitializer({
                fac: this._storeFactory,
                defaults
            });
            const props = this._properties;
            _initializationPending = initializer
                .init(props)
                .catch((e) => {
                    if (props.notifyAboutErrors) {
                        this._logError(props.id, e);
                    }
                    throw e;
                })
                .finally(() => {
                    _initializationPending = undefined;
                });
            return _initializationPending;
        },

        _logError(id, error) {
            const msg = replace(this._i18n.get().metadataError, { id, error });
            this._logger.error(msg, error);
            return error;
        },

        _observeLayer(layerId) {
            const mapWidgetModel = this._mapWidgetModel;
            const path = parseLayerPath(layerId);
            this._buildLayerObserver(mapWidgetModel, path);
            observers.add(
                mapWidgetModel.watch("map", ({ value }) => {
                    observers.clean("layerobserver");
                    if (value) {
                        this._buildLayerObserver(mapWidgetModel, path);
                    }
                })
            );
        },

        _buildLayerObserver(mapWidgetModel, path) {
            const observer = LayerObserver({
                map: mapWidgetModel.map,
                filter(layer) {
                    return path.layerId === layer.id;
                },
                notify: (layer, context) => this._trackLayerChange(path, layer, context.change.removed)
            });
            observer.start();
            observers.clean("layerobserver");
            observers.group("layerobserver").add({ remove: () => observer.stop() });
            return observer;
        },

        _trackLayerChange(path, layer, removed) {
            // clean up visiblity watches
            this._trackVisibilityChanges(undefined);
            if (removed) {
                this._checkStoreRegistrationStateAsync(undefined);
                return;
            }
            // added or moved
            if (layer.loaded) {
                if (!path.subLayerId) {
                    this._trackVisibilityChanges(layer);
                    this._checkStoreRegistrationStateAsync(layer);
                    return;
                }
                this._trackSublayerChange(layer, path.subLayerId);
                return;
            }

            observers.clean("loaded");
            observers.group("loaded").add(
                layer.watch("loaded", () => {
                    observers.clean("loaded");
                    if (!path.subLayerId) {
                        this._trackVisibilityChanges(layer);
                        this._checkStoreRegistrationStateAsync(layer);
                        return;
                    }
                    this._trackSublayerChange(layer, path.subLayerId);
                    return;
                })
            );
        },

        _trackSublayerChange(layer, subLayerId) {
            const sublayer = lookupSublayerById(layer, subLayerId);
            this._trackVisibilityChanges(sublayer);
            this._checkStoreRegistrationStateAsync(sublayer);
        },

        _trackVisibilityChanges(layerOrSublayer) {
            const visibilityObservers = observers.group("visibility");
            visibilityObservers.clean();
            if (!layerOrSublayer) {
                return;
            }
            iterateLayerHierarchy(layerOrSublayer, (l) => {
                if (l.visible === undefined) {
                    return;
                }
                visibilityObservers.add(
                    l.watch("visible", () => {
                        this._checkStoreRegistrationStateAsync(layerOrSublayer);
                    })
                );
            });
        },

        _checkStoreRegistrationStateAsync(targetLayer) {
            _changeTask = _changeTask || AsyncTask(this._checkStoreRegistrationState.bind(this));
            const delay = 100;
            _changeTask.delay(delay, targetLayer);
        },

        _checkStoreRegistrationState(targetLayer) {
            if (!targetLayer) {
                _layerRemoved = true;
                _unregisterStore();
                return;
            }
            _layerRemoved = false;
            if (!isVisibleInHierarchy(targetLayer)) {
                _unregisterStore();
                return;
            }
            if (_registration || _initializationPending) {
                // already registered or will be
                return;
            }
            this._initStore()
                .then(({ store, props, nonFilteredStore }) => {
                    // double check visibility
                    if (_destroyed || _layerRemoved || !isVisibleInHierarchy(targetLayer)) {
                        return;
                    }
                    this._register(store, props, targetLayer, nonFilteredStore);
                })
                .catch((e) => {
                    console.warn(`[agssearch] Store '${this._properties.id}' could not be initialized. ${e}`);
                });
        },

        deactivate() {
            observers.clean();
            _unregisterStore();
            _initializationPending = undefined;
            _changeTask && _changeTask.cancel();
            _changeTask = undefined;
            _destroyed = true;
        },

        _register(store, props, targetLayer, nonFilteredStore) {
            _unregisterStore();
            if (nonFilteredStore && targetLayer && props.legacyImplementation) {
                nonFilteredStore.definitionExpression = targetLayer.definitionExpression || "";
                const watchHandle = targetLayer.watch(
                    "definitionExpression",
                    () => (nonFilteredStore.definitionExpression = targetLayer.definitionExpression || "")
                );
                observers.group("defQuery").add(watchHandle);
            }
            observers.group("store").add({
                destroy() {
                    store?.destroy?.();
                }
            });
            _registration = this._componentContext.getBundleContext().registerService(["ct.api.Store"], store, props);
        }
    };
}

function iterateLayerHierarchy(layer, cb) {
    let current = layer;
    while (current) {
        if (cb(current) === false) {
            return;
        }
        const parent = current.parent;
        current = parent === current ? undefined : parent;
    }
}

function isVisibleInHierarchy(layer) {
    let isVisible = true;
    iterateLayerHierarchy(layer, (l) => {
        const v = l.visible;
        if (v === undefined) {
            return false;
        }
        return (isVisible = v);
    });
    return isVisible;
}

function lookupSublayerById(layer, id) {
    const idAsNumber = parseInt(id, 10);
    if (!layer.findSublayerById) {
        // a group layer
        if (layer.findLayerById) {
            console.warn(
                `agssearch: Illegal detected layer '${layer.id}' is a group layer.` +
                    `This is an illegal referenced layer. Please use the id of the target service directly '${id}'`
            );
        } else {
            console.warn(`agssearch: Illegal detected layer '${layer.id}' has no sub layers to lookup id '${id}'.`);
        }
        return;
    }
    if (isNaN(idAsNumber)) {
        console.warn(
            `agssearch: Illegal sub layer id '${id}' for layer id '${layer.id}' used,` + ` this should be a number.`
        );
        return;
    }
    return layer.findSublayerById(idAsNumber);
}
