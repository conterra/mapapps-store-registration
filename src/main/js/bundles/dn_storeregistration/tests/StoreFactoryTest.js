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
import { assert } from "chai";
import md from "module";
import { LayerStore } from "../LayerStore";
import { StoreFactory } from "../StoreFactory";

const layers = {
    geojsonLayer: {
        url: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_month.geojson",
        type: "geojson",
    }
};

function create() {
    const fac = new StoreFactory();
    // mock mapWidgetModel
    fac._mapWidgetModel = {
        map: {
            findLayerById(name) {
                return layers[name];
            }
        }
    };
    return fac;
}

describe(md.id, function() {
    it("expect that store without 'target' and without 'url' can not be created", async function() {
        const promise = create().createStore({});
        try {
            await promise;
            assert.fail("expected error");
        } catch (e) {
            assert.match(e.message, /target/);
        }
    });

    it("expect that LayerStore implementation is returned by default can be created", async function() {
        const store = await create().createStore({
            id: "test",
            layerId: "geojsonLayer"
        });
        assert.equal(store.id, "test");
        assert(store instanceof LayerStore);
    });

    it("expect that url is looked up from layer if layerId is defined", async function() {
        const store = await create().createStore({
            id: "test",
            layerId: "geojsonLayer"
        });
        assert.equal(store.target, layers.geojsonLayer.url);
    });

    it("expect that url looked up from layer overwrites predefined urls", async function() {
        const store = await create().createStore({
            id: "test",
            target: "http://test.de",
            layerId: "geojsonLayer"
        });
        assert.equal(store.target, layers.geojsonLayer.url);
    });

    it("expect that url is extended by sublayer id if defined", async function() {
        const store = await create().createStore({
            id: "test",
            target: "http://test.de",
            layerId: "geojsonLayer/2",
            legacyImplementation: true
        });
        assert.equal(store.target, layers.geojsonLayer.url + "/2");
    });
});
