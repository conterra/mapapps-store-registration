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
import { assert } from "chai";
import md from "module";
import later from "test-utils/later";
import Map from "esri/Map";
import { AutoStoreRegistration } from "../AutoStoreRegistration";
import GeoJSONLayer from "esri/layers/GeoJSONLayer";
import CSVLayer from "esri/layers/CSVLayer";

let autoStoreRegistration;
let registeredStores = [];
let registeredStoresById = {};
let unregisteredStores = [];

const createAutoStoreRegistration = (map, legacy) => {
    autoStoreRegistration = new AutoStoreRegistration();
    autoStoreRegistration._map = map;
    autoStoreRegistration._delay = 0;
    autoStoreRegistration._useLegacyImplementation = !!legacy;
    autoStoreRegistration._storeFactory = {
        createStore: () => {
            return {
                getMetadata: () =>
                    Promise.resolve({
                        capabilities: "Query"
                    })
            };
        }
    };
    autoStoreRegistration._bundleContext = {
        registerService: (provides, store, { id }) => {
            registeredStores.push(id);
            registeredStoresById[id] = store;
            return {
                unregister: () => {
                    unregisteredStores.push(id);
                }
            };
        }
    };
    autoStoreRegistration._observeMap();
};

const getGeoJSONLayer = () => {
    const geoJSONLayer = new GeoJSONLayer({
        url: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_month.geojson",
        id: "earthquakes_geojson"
    });
    geoJSONLayer.load();
    return geoJSONLayer;
};

const getCSVLayer = () => {
    const csvLayer = new CSVLayer({
        "url": "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_month.csv",
        id: "earthquakes_csv"
    });
    csvLayer.load();
    return csvLayer;
};

describe(md.id, function () {
    afterEach(async function () {
        autoStoreRegistration.deactivate();
        await later();
        registeredStores = [];
        registeredStoresById = {};
        unregisteredStores = [];
        autoStoreRegistration = undefined;
    });

    it("expect GeoJSONLayer is registered as store", async function () {
        const map = new Map({
            layers: [getGeoJSONLayer()]
        });
        createAutoStoreRegistration(map);
        await mapReady(map);

        assert.deepEqual(registeredStores, ["earthquakes_geojson"]);
    });

    it("expect CSVLayer is registered as store", async function () {
        const map = new Map({
            layers: [getCSVLayer()]
        });
        createAutoStoreRegistration(map);
        await mapReady(map);

        assert.deepEqual(registeredStores, ["earthquakes_csv"]);
    });

    it("expect layer with loadStatus failed is not registered as store", async function () {
        const geoJSONLayer = getGeoJSONLayer();
        geoJSONLayer.watch("loaded", () => {
            geoJSONLayer.loadStatus = "failed";
        });
        const map = new Map({
            layers: [geoJSONLayer]
        });
        createAutoStoreRegistration(map);
        await mapReady(map);
        assert.deepEqual(registeredStores, []);
    });

    it("expect removing geojson unregisters store", async function () {
        const map = new Map({
            layers: [getGeoJSONLayer()]
        });
        createAutoStoreRegistration(map);
        await mapReady(map);

        assert.deepEqual(registeredStores, ["earthquakes_geojson"]);
        map.layers.removeAll();
        await mapReady(map);

        assert.deepEqual(unregisteredStores, ["earthquakes_geojson"]);
    });

    it("expect later added layer is registered as store", async function () {
        const map = new Map({
            layers: [getCSVLayer()]
        });
        createAutoStoreRegistration(map);
        await mapReady(map);

        map.layers.add(getGeoJSONLayer());
        await mapReady(map);

        assert.deepEqual(registeredStores, ["earthquakes_csv", "earthquakes_geojson"]);
    });

    it("expect 'definitionExpression' property changes on store if changed on layer", async function () {
        const layer = getGeoJSONLayer();
        const map = new Map({
            layers: [layer]
        });
        createAutoStoreRegistration(map, true);
        await mapReady(map);
        assert.deepEqual(registeredStores, ["earthquakes_geojson"]);
        const store = registeredStoresById["earthquakes_geojson"];
        assert.deepEqual(store.definitionExpression, "");
        layer.definitionExpression = "1 = 1";
        await later();
        assert.deepEqual(store.definitionExpression, "1 = 1");
    });
});

async function mapReady(map) {
    await Promise.all(map.allLayers.map(layer => layer.when()).toArray());
    await later();
}
