/*
 * Copyright (C) 2022 con terra GmbH (info@conterra.de)
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
/** @module */
import MapServerLayerStore from "ct/mapping/store/MapServerLayerStore";
// Use patched LayerStore
import { LayerStore } from "./LayerStore";
import { parseLayerPath } from "./util";

/**
 * Factory class that creates store instances.
 */
export class StoreFactory {
    /**
     * Creates a new store instance backed by an ArcGIS Feature Server or Map Server.
     * Either the `layerId` parameter or the `url` parameter must be specified.
     *
     * @param {Object} options
     * @param {string} [options.id] The id of the new store
     * @param {string} [options.layerId] A valid layer or sublayer id
     * @param {string} [options.url] A service url, for services that are not in the map
     * @param {boolean} [options.legacyImplementation]
     *      Set this value to `true` to use the deprecated old MapServerLayerStore implementation
     *      instead of the new LayerStore.
     * @returns A promise that resolves to the new store instance
     */
    async createStore(options) {
        options = Object.assign({}, options);
        const target = (options.target = options.target || options.url || "");
        const layerId = options.layerId || "";

        if (!layerId && !target) {
            throw new Error("missing 'target' or 'url' property");
        }

        if (layerId && target) {
            console.warn("AGSStoreFactory: Both properties url and layerId are set. Property url will be ignored!");
        }

        if (options.legacyImplementation) {
            return this._createLegacyStore(layerId, options);
        }
        return this._createLayerStore(layerId, target, options);
    }

    _createLegacyStore(layerId, options) {
        if (layerId) {
            delete options.target;
            delete options.url;
            const metaInfo = this._getServiceInfoFromMap(layerId);
            if (!metaInfo) {
                throw new Error("could not resolve " + layerId + " in map");
            }
            options = Object.assign({}, metaInfo, options);
        }
        return new MapServerLayerStore(options);
    }

    async _createLayerStore(layerId, target, options) {
        if (layerId) {
            return await LayerStore.forLayerPath(options.id, layerId, this._mapWidgetModel?.map);
        }
        return LayerStore.forLayerUrl(options.id, target, options.type);
    }

    _getServiceInfoFromMap(layerId) {
        const path = parseLayerPath(layerId);
        const map = this._mapWidgetModel.map;
        const layer = map.findLayerById(path.layerId);
        if (!layer) {
            return undefined;
        }
        const { url, options } = layer;
        if (layer.type === "feature" && !path.subLayerId) {
            // layer.url does not contain sublayer id in case of feature layer
            path.subLayerId = layer.layerId;
        }
        const targetUrl = path.subLayerId !== undefined ? url + "/" + path.subLayerId : url;
        return Object.assign({}, options, {
            target: targetUrl
        });
    }
}
