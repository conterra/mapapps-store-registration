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
import LayerObserver from "map-widget/LayerObserver";
import LayerTraverser from "map-widget/LayerTraverser";
import Observers from "apprt-core/Observers";
import AsyncTask from "apprt-core/AsyncTask";
import assignWithPrototype from "apprt-core/assignWithPrototype";

const DELAY = 100;
const STATE_UNREGISTERED = "unregistered";
const STATE_REGISTERING = "registering";
const STATE_REGISTERED = "registered";
const STATE_UNREGISTERING = "unregistering";

let registerCount = 0;
export class AutoStoreRegistration {
    constructor() {
        this._observers = Observers();
        // id to object for registration and unregistration tasks
        this._storeRegistrations = new Map();
    }

    activate(componentContext) {
        this._bundleContext = componentContext.getBundleContext();
        this._delay = this._properties.delay || DELAY;
        this._useLegacyImplementation = this._properties.legacyImplementation ?? false;
        this._observeMap();
    }

    _observeMap() {
        const observers = this._observers;
        let layerObserver = LayerObserver({
            map: this._map,
            notify: (layer, context) => {
                if (!isAllowedType(layer)) {
                    return;
                }
                const id = buildStoreId(layer);
                if (context.change.added) {
                    this._checkServiceLayer(layer, id);
                    observers.group(id).add(this._observeLayer(layer, (layer) => this._checkServiceLayer(layer, id)));
                } else if (context.change.removed) {
                    observers.group(id).clean();
                    this._delayedUnregisterStore(layer, id);
                }
            }
        });
        layerObserver.start();
        this._observers.add({
            remove() {
                layerObserver.stop();
                layerObserver = undefined;
            }
        });
    }

    _observeLayer(layer, callback) {
        const observers = [];
        const watchString = "visible" + (isLoading(layer) ? ", loadStatus" : "");
        observers.push(
            layer.watch(watchString, () => {
                callback(layer);
            })
        );
        observers.push(
            watchIsVisibleInHierarchy(layer, () => {
                callback(layer);
            })
        );
        return {
            remove: () => observers.forEach((observer) => observer.remove())
        };
    }

    _checkServiceLayer(layer, id) {
        this._observers.group(`${id}-children`).clean();
        if (isVisibleAndReady(layer)) {
            this._observeServiceLayer(layer, id);
        } else {
            this._delayedUnregisterStore(layer, id);
        }
    }

    _observeServiceLayer(rootLayer, id) {
        const watchId = `${id}-children`;
        const traverser = LayerTraverser({
            layer: rootLayer,
            includeRoot: true,
            action: (layer) => {
                const id = buildStoreId(layer);
                if (isVisibleAndReady(layer)) {
                    this._checkSublayer(layer, id);
                }
                this._observers
                    .group(watchId)
                    .add(this._observeLayer(layer, (layer) => this._checkSublayer(layer, id)));
            }
        });
        traverser.traverse();
    }

    _checkSublayer(layer, id) {
        if (!hasSubLayers(layer) && isVisibleAndReady(layer)) {
            this._delayedRegisterStore(layer, id);
        } else {
            this._delayedUnregisterStore(layer, id);
        }
    }

    _delayedRegisterStore(layer, id) {
        let item = this._storeRegistrations.get(id);
        if (!item) {
            item = {
                // registering, registered, unregistering
                layer,
                id,
                state: STATE_UNREGISTERED,
                register: AsyncTask(this._registerStore.bind(this)),
                unregister: AsyncTask(this._unregisterStore.bind(this)),
                cleanup: undefined
            };
            this._storeRegistrations.set(id, item);
        }

        if (item.layer !== layer) {
            console.warn(`Layers with equal ids detected, only one will be registered: ${id}`);
            return;
        }
        if (item.state === STATE_REGISTERING) {
            // registration already on going
            return;
        }
        if (item.state === STATE_UNREGISTERING) {
            item.unregister.cancel();
            item.cleanup?.();
        }
        item.registerId = ++registerCount;
        item.state = STATE_REGISTERING;
        item.register.delay(this._delay, layer, id, item.registerId);
    }

    _delayedUnregisterStore(layer) {
        // remove layer and all child stores
        const traverser = LayerTraverser({
            layer: layer,
            includeRoot: true,
            action: (layer) => {
                const id = buildStoreId(layer);
                const item = this._storeRegistrations.get(id);
                if (!item || item.state === STATE_UNREGISTERING || item.layer !== layer) {
                    return;
                }
                item.state = STATE_UNREGISTERING;
                item.register.cancel();
                item.unregister.delay(this._delay, layer, id, item.registerId);
            }
        });
        traverser.traverse();
    }

    async _registerStore(layer, id, registerId) {
        const item = this._storeRegistrations.get(id);
        if (!item || item.state !== STATE_REGISTERING || item.registerId !== registerId) {
            // canceled
            return;
        }
        let store;
        let definitionExpressionWatchHandle;
        let registration;
        const cleanup = () => {
            registration?.unregister();
            registration = undefined;
            definitionExpressionWatchHandle?.remove();
            definitionExpressionWatchHandle = undefined;
            store?.destroy?.();
            store = undefined;
        };
        try {
            store = await this._storeFactory.createStore({
                id,
                layerId: id,
                fetchIdProperty: true,
                legacyImplementation: this._useLegacyImplementation
            });
            if (this._useLegacyImplementation) {
                store.definitionExpression = layer.definitionExpression || "";
                definitionExpressionWatchHandle = layer.watch(
                    "definitionExpression",
                    () => (store.definitionExpression = layer.definitionExpression || "")
                );
            }
            const metadata = await store.getMetadata();
            if (this._useLegacyImplementation && metadata.capabilities.indexOf("Query") < 0) {
                console.warn(`AutoStoreRegistration: Layer ${id} does not support queries!`);
            }
            const options = getOptionsFromMetadata(metadata, layer, id);
            assignWithPrototype(store, options);
            const properties = this._properties || {};
            options.useIn = (layer.useIn || properties.useIn || []).slice(0);
            const item = this._storeRegistrations.get(id);
            // maybe unregister called...
            if (!item || item.state !== STATE_REGISTERING || item.registerId !== registerId) {
                cleanup();
                return;
            }
            registration = this._bundleContext.registerService(["ct.api.Store"], store, options);
            item.cleanup = cleanup;
            item.state = STATE_REGISTERED;
        } catch (error) {
            console.warn(`AutoStoreRegistration: Error while store registration ${id}: ${error.message}`);
            cleanup();
            const item = this._storeRegistrations.get(id);
            if (!item || item.state !== STATE_REGISTERING || item.registerId !== registerId) {
                return;
            }
            this._storeRegistrations.delete(id);
        }
    }

    _unregisterStore(layer, id, registerId) {
        const item = this._storeRegistrations.get(id);
        if (!item || item.state !== STATE_UNREGISTERING || item.layer !== layer || item.registerId !== registerId) {
            // already unregistered
            return;
        }
        item.cleanup?.();
        item.cleanup = undefined;
        this._storeRegistrations.delete(id);
    }

    deactivate() {
        //stopping LayerObserver triggers unregister of all stores
        this._observers.clean();
    }
}

function buildStoreId(layer) {
    return layer.layer ? `${layer.layer.id}/${layer.id}` : `${layer.id}`;
}

function isAllowedType(layer) {
    return ["geojson", "csv", "wfs"].includes(layer.type);
}

function isLoading(layer) {
    return layer.loadStatus === "not-loaded" || layer.loadStatus === "loading";
}

function isVisibleAndReady(layer) {
    return (
        layer.visible &&
        ((!isLoading(layer) && layer.loadStatus !== "failed")
            || isSubLayer(layer))
        && isVisibleInHierarchy(layer)
    );
}

function hasSubLayers(layer) {
    return layer.sublayers && layer.sublayers.length;
}

function isSubLayer(layer) {
    // Dirty: only sublayers have the layer property
    const parentLayer = layer && layer.layer;
    return parentLayer !== undefined;
}

function isRoot(layer) {
    return layer.declaredClass === "esri.Map";
}

function isVisibleInHierarchy(layer) {
    if (!layer.visible) return false;
    const parentLayer = layer.parent;
    if (parentLayer && !isRoot(parentLayer)) {
        return isVisibleInHierarchy(parentLayer);
    }
    return layer.visible;
}

function watchIsVisibleInHierarchy(layer, callback) {
    const observers = [];
    let parentLayer = layer.parent;
    while (parentLayer && !isRoot(parentLayer)) {
        observers.push(parentLayer.watch("visible", callback));
        parentLayer = parentLayer.parent;
    }
    return {
        remove: () => observers.forEach((observer) => observer.remove())
    };
}

function getOptionsFromMetadata(metadata, candidate, id) {
    const title = candidate.title || metadata.title;
    const description = candidate.description || metadata.description;
    const opts = candidate.options;
    return assignWithPrototype(
        {},
        {
            title: title || id,
            description: description,
            omniSearchDefaultLabel: title || id,
            omniSearchSearchAttr: metadata.displayField
        },
        opts,
        {
            id: id,
            layerId: id,
            fetchIdProperty: true
        }
    );
}
