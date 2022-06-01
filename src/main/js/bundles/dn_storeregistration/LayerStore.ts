///
/// Copyright (C) 2022 con terra GmbH (info@conterra.de)
///
/// Licensed under the Apache License, Version 2.0 (the "License");
/// you may not use this file except in compliance with the License.
/// You may obtain a copy of the License at
///
///         http://www.apache.org/licenses/LICENSE-2.0
///
/// Unless required by applicable law or agreed to in writing, software
/// distributed under the License is distributed on an "AS IS" BASIS,
/// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
/// See the License for the specific language governing permissions and
/// limitations under the License.
///
import Layer from "esri/layers/Layer";
import GeoJSONLayer from "esri/layers/GeoJSONLayer";
import CSVLayer from "esri/layers/CSVLayer";
import type Field from "esri/layers/support/Field";
import type Graphic from "esri/Graphic";
import type Query from "esri/rest/support/Query";
import type Map from "esri/Map";
import type {ComplexQueryExpression} from "store-api/api/ComplexQueryLang";
import type {
    AsyncStore,
    GetOptions,
    Metadata,
    FieldData,
    QueryOptions,
    SortOptions,
    GeometryOptions,
    PaginationOptions,
    AsyncQueryResult,
    ResultItems,
    AbortOptions
} from "store-api/api/Store";
import type {AST, ComplexQueryOptions, Walker} from "store-api/ComplexQuery";
import SpatialQuery from "store-api/SpatialQuery";
import {Stream} from "apprt-streams/Stream";
import {astToSQLWhere} from "store-api/rest/ComplexQueryToSQL";
import {buildResult, toQueryResult} from "store-api/utils";
import CancelablePromise from "apprt-core/CancelablePromise";
import {parseLayerPath} from "./util";

export interface LayerStoreMetadata extends Metadata {
    /** The feature id property name. Same as store.idProperty. */
    readonly idProperty: string;

    /** Whether the store supports pagination or not. */
    readonly supportsPagination: boolean;

    /** Maximum number of features that can be requested from the server. */
    readonly maxRecordCount: number;
}

type QueryableLayerProps =
    | "type"
    | "destroy"
    | "load"
    | "loaded"
    | "url"
    | "layerId"
    | "capabilities"
    | "sourceJSON"
    | "objectIdField"
    | "title"
    | "displayField"
    | "geometryType"
    | "fullExtent"
    | "popupTemplate"
    | "fields"
    | "createQuery"
    | "queryObjectIds"
    | "queryFeatures"
    | "queryFeatureCount";

// Simplified feature layer to make mocking simpler
export type SimpleQueryableLayer = Pick<Layer, QueryableLayerProps>;

interface BaseState {
    /** Store id */
    id: string | undefined;

    /** Layer to use as data source */
    layer: SimpleQueryableLayer;

    /** True if the layer is owned by the store. It will be cleaned up in destroy(). */
    layerOwned?: boolean;
}

interface InitializedState extends BaseState {
    /** Parsed metadata once the layer has been loaded */
    metadata: LayerStoreMetadata;
}

type State = ({ initialized: false } & BaseState) | ({ initialized: true } & InitializedState);

type Feature = Record<string, any>;

type FeatureId = string | number;

/**
 * A store implementation that searches directly on an ArcGIS Feature Layer object.
 */
export class LayerStore implements AsyncStore<Feature, FeatureId> {
    // Never used, just here to satisfy the compiler. See hack in the constructor.
    readonly id: string | undefined;
    readonly idProperty!: string;
    readonly layer!: SimpleQueryableLayer;
    readonly target!: string | undefined;
    readonly url!: string | undefined;

    #state: State;
    #loadPromise: Promise<InitializedState> | undefined = undefined;

    private constructor(options: BaseState) {
        const state = (this.#state = Object.assign({initialized: false} as const, options));
        if (state.layer.type !== "geojson" && state.layer.type !== "csv" ) {
            throw new Error("agssearch/LayerStore: can only be used with geojson or csv layers");
        }

        // Hack to fix private properties in combination with apprt-core/delegate.
        // If delegate is used, private state is on the wrapped prototype and not on
        // the actual "this" object, so the private property cannot be accessed.
        const bindGetter = (impl: any) => {
            return {get: impl.bind(this), enumerable: true};
        };
        const bindMethod = (method: any) => {
            return {value: method.bind(this)};
        };
        Object.defineProperties(this, {
            id: bindGetter(this.#id),
            idProperty: bindGetter(this.#idProperty),
            layer: bindGetter(this.#layer),
            target: bindGetter(this.#target), // compatibility with old store
            url: bindGetter(this.#target),
            destroy: bindMethod(this.destroy),
            load: bindMethod(this.load),
            getMetadata: bindMethod(this.getMetadata),
            getIdentity: bindMethod(this.getIdentity),
            query: bindMethod(this.query),
            get: bindMethod(this.get)
        });
    }

    /**
     * Creates a new store instance for the given layer path.
     * The layer (or sublayer) must exist in the map.
     * Currently only feature layers and sublayers of map image layers are supported.
     */
    static async forLayerPath(id: string | undefined, layerPath: string, map: Map): Promise<LayerStore> {
        const {layerId, subLayerId} = parseLayerPath(layerPath) ?? {};
        if (!layerId) {
            throw new Error(`agssearch/LayerStore: invalid layer id in layer path '${layerPath}'`);
        }

        const layer = map.findLayerById(layerId);
        if (!layer) {
            throw new Error(`agssearch/LayerStore: layer '${layerId}' not found in map'`);
        }

        switch (layer.type) {
            case "geojson": {
                if (subLayerId) {
                    throw new Error(
                        `agssearch/LayerStore: sublayers are not supported when working with geojson layers`
                    );
                }
                return LayerStore.forGeoJSONLayer(id, layer as GeoJSONLayer);
            }
            case "csv": {
                if (subLayerId) {
                    throw new Error(
                        `agssearch/LayerStore: sublayers are not supported when working with csv layers`
                    );
                }
                return LayerStore.forCSVLayer(id, layer as CSVLayer);
            }
            default:
                throw new Error(`agssearch/LayerStore: layer type '${layer.type}' is not supported`);
        }
    }

    /**
     * Creates a new store instance from the provided layer url.
     *
     * @param id the store's id (optional).
     * @param url the url of the layer the store should search on.
     * @param type the type of the layer the store should search on.
     */
    static forLayerUrl(id: string | undefined, url: string, type: string): LayerStore {
        let layer;
        switch(type) {
            case "geojson":
                layer = new GeoJSONLayer({url: url});
                break;
            case "csv":
                layer = new CSVLayer({url: url});
                break;
            default:
                layer = new GeoJSONLayer({url: url});
        }
        return LayerStore.forGeoJSONLayer(id, layer, true);
    }

    /**
     * Creates a new store instance that searches on the provided geojson layer.
     *
     * @param id the store's id (optional)
     * @param layer the geojson layer to use as a data source
     * @param cleanUpLayer True if the layer should be cleaned up by the store.
     */
    static forGeoJSONLayer(id: string | undefined, layer: SimpleQueryableLayer, cleanUpLayer = false): LayerStore {
        return new LayerStore({id, layer, layerOwned: cleanUpLayer});
    }

    /**
     * Creates a new store instance that searches on the provided csv layer.
     *
     * @param id the store's id (optional)
     * @param layer the csv layer to use as a data source
     * @param cleanUpLayer True if the layer should be cleaned up by the store.
     */
    static forCSVLayer(id: string | undefined, layer: SimpleQueryableLayer, cleanUpLayer = false): LayerStore {
        return new LayerStore({id, layer, layerOwned: cleanUpLayer});
    }

    destroy(): void {
        const state = this.#state;
        if (state.layerOwned) {
            state.layer.destroy();
            state.layerOwned = false;
        }
    }

    #id(): string | undefined {
        return this.#state.id;
    }

    #idProperty(): string {
        const state = this.#state;
        if (!state.initialized) {
            throw new Error("agssearch/LayerStore: cannot use store before it has been initialized");
        }
        return state.metadata.idProperty;
    }

    #layer(): SimpleFeatureLayer {
        const state = this.#state;
        return state.layer;
    }

    #target(): string | undefined {
        const state = this.#state;
        let url = state.layer.url || undefined;
        if (!url) {
            return url;
        }

        const layerId = state.layer.layerId;
        if (layerId != null) {
            const suffix = `/${layerId}`;
            if (!url.endsWith(suffix)) {
                url += suffix;
            }
        }
        return url;
    }

    async load(): Promise<void> {
        await this.#load(); // don't give state to the public
    }

    async #load(): Promise<InitializedState> {
        return (this.#loadPromise ??= this.#initializeStateWithMetadata());
    }

    async #initializeStateWithMetadata(): Promise<InitializedState> {
        const layer = this.#state.layer;
        await layer.load();
        const metadata = parseMetadata(layer);

        return Object.assign(this.#state, {
            initialized: true,
            metadata: metadata
        }) as InitializedState;
    }

    async getMetadata(): Promise<LayerStoreMetadata> {
        return (await this.#load()).metadata;
    }

    getIdentity(feature: Feature): string | number {
        const state = this.#state;
        if (!state.initialized) {
            throw new Error("agssearch/LayerStore: cannot use store before it has been initialized");
        }
        return feature[state.metadata.idProperty];
    }

    query(query?: ComplexQueryExpression, options?: QueryOptions): AsyncQueryResult<Feature> {
        const {aborter, options: cancelableOptions} = createCancelableOptions(options);
        const promise = this.#queryImpl(query, cancelableOptions);
        return toQueryResult(createLegacyPromise(aborter, promise));
    }

    async #queryImpl(query?: ComplexQueryExpression, options?: QueryOptions): Promise<ResultItems<Feature>> {
        const {
            layer,
            metadata: {idProperty, supportsPagination}
        } = await this.#load();
        const signal = options?.signal;
        const postprocessItems = supportsPagination
            ? identity
            : <T>(items: T[]) => truncateResults(items, options?.count);

        // No features requested; just return the total.
        if (options?.count === 0) {
            const params = this.#createQueryParams("only-count", query, options);
            const total = await layer.queryFeatureCount(params, {signal});
            return buildResult([], total);
        }

        // Optimization: id queries are very cheap and apparently dont have a limit for the number of results.
        if (onlyRequestsIdProperty(idProperty, options?.fields)) {
            const params = this.#createQueryParams("only-ids", query, options);
            const ids = postprocessItems(await layer.queryObjectIds(params, {signal}));
            const items = buildResult(
                ids.map((id): Feature => {
                    return {[idProperty]: id};
                }),
                ids.length
            );
            return items;
        }

        // Total can be provided by the caller to suppress the feature count request.
        // It's not documented at the moment but mimics the old MapServerLayerStore behavior.
        let total: number | undefined = options?.total;
        if (total == null && supportsPagination) {
            // Query server with same options but disabled pagination to find out the total count
            const params = this.#createQueryParams(
                "only-count",
                query,
                Object.assign({}, options, {
                    start: undefined,
                    count: undefined
                })
            );
            total = await layer.queryFeatureCount(params, {signal});
        }
        const params = this.#createQueryParams("full", query, options);
        // Fix geojson query errors in resultcenter
        if (layer.type === "geojson" || layer.type === "csv") {
            params.num = undefined;
        }
        const {features: items} = await layer.queryFeatures(params, {signal});
        const result = buildResult(postprocessItems(items).map(toFeature), total);
        return result;
    }

    #createQueryParams(
        type: "full" | "only-ids" | "only-count",
        query: ComplexQueryExpression | undefined,
        options: QueryOptions | undefined
    ): Query {
        const state = this.#state;
        if (!state.initialized) {
            throw new Error("internal error: state not initialized");
        }

        const {
            layer,
            metadata: {idProperty, maxRecordCount, supportsSorting, supportsGeometry, supportsPagination}
        } = state;

        const params = layer.createQuery();
        merge(
            params,
            translateQuery(params.where || undefined, query, options),
            translatePagination(supportsPagination, maxRecordCount, options)
        );

        // Fields and geometry options only needed for queries returning actual items.
        if (type === "full") {
            merge(
                params,
                translateFields(idProperty, options?.fields, options?.sort),
                supportsGeometry && translateGeometry(!!options?.fields?.geometry, options?.geometry)
            );
        }

        // Don't apply sorting when not returning any items or ids.
        if (type !== "only-count") {
            merge(params, supportsSorting && translateSort(options?.sort));
        }
        return params;
    }

    get(id: FeatureId, options?: GetOptions): Promise<Feature | undefined> {
        const {aborter, options: cancelableOptions} = createCancelableOptions(options);
        const promise = this.#getImpl(id, cancelableOptions);
        return toQueryResult(createLegacyPromise(aborter, promise));
    }

    async #getImpl(id: FeatureId, options?: GetOptions): Promise<Feature | undefined> {
        const {
            metadata: {idProperty}
        } = await this.#load();

        const query = {
            [idProperty]: {
                $eq: id
            }
        };

        const fields = Object.assign({}, options?.fields);
        fields.geometry ??= true;
        const queryOptions: QueryOptions = Object.assign({}, options, {
            count: 1,
            total: 1,
            fields
        });

        const features = await this.query(query, queryOptions);
        return features[0];
    }
}

// Maps the query to spatial and sql query parameters.
function translateQuery(
    initialWhere: string | undefined,
    query: ComplexQueryExpression | undefined,
    options: ComplexQueryOptions | undefined
): Partial<Query> {
    const ast = SpatialQuery.parse(query, Object.assign({suggestContains: true}, options)).ast.optimize();
    const spatialOptions = translateSpatialQuery(ast);
    const whereOptions = translateWhereQuery(initialWhere, ast);
    return Object.assign(spatialOptions, whereOptions);
}

function translateWhereQuery(initialWhere: string | undefined, ast: AST): Partial<Query> {
    // TODO: Object based id query?
    const querySQL = astToSQLWhere(ast);
    let where = initialWhere;
    if (querySQL) {
        where = where ? `(${where}) AND (${querySQL})` : querySQL;
    }
    where ||= "1=1";
    return {where};
}

function translateSpatialQuery(ast: AST): Partial<Query> {
    const walker = ast.walker();
    if (walker.isROOT() && !walker.toFirstChild()) {
        return {spatialRelationship: undefined};
    }

    const params: Partial<Query> = {};
    const visitOperator = (walker: Walker) => {
        const node = walker.current;
        const rel = node.o.substring(1);
        if (!isSupportedRelationShip(rel)) {
            return false;
        }

        // Apply query parameters
        params.geometry = node.v;
        params.spatialRelationship = rel;

        // Remove node from parent.
        const siblings = walker.parent()!.c!;
        const index = siblings.indexOf(node);
        siblings.splice(index, 1);
        return true;
    };
    const visitNode = (walker: Walker) => {
        if (visitOperator(walker)) {
            return true;
        }
        if (walker.current.o === "$and") {
            for (let w = walker.toFirstChild(); w; w = w.toNextSibling()) {
                if (visitNode(w)) {
                    return true;
                }
            }
        }
        return false;
    };

    // Visits ast nodes until a spatial operation is found.
    // Only a single spatial operation is supported, and it must be either at top level
    // or chained within $and expressions.
    visitNode(walker);
    return params;
}

type SpatialRelationship = Query["spatialRelationship"];

// Using a record here means that we can get a compile error if esri adds or removes relationships.
const SUPPORTED_SPATIAL_RELATIONSHIPS: Record<SpatialRelationship, 1> = {
    "intersects": 1,
    "contains": 1,
    "crosses": 1,
    "disjoint": 1,
    "envelope-intersects": 1,
    "index-intersects": 1,
    "overlaps": 1,
    "touches": 1,
    "within": 1,
    "relation": 1
};

function isSupportedRelationShip(rel: string): rel is SpatialRelationship {
    return !!(SUPPORTED_SPATIAL_RELATIONSHIPS as any)[rel];
}

// Maps { fieldA: 1, fieldB: false, fieldC: true } to [fieldA, fieldC].
// The object id is always requested.
function translateFields(
    idProperty: string,
    fields: QueryOptions["fields"],
    sort?: QueryOptions["sort"]
): Partial<Query> {
    const outFields = Stream.entries(fields ?? {})
        .filterMap(([k, v]) => (v ? k : undefined))
        // sort fields must be in out fields
        .concatWith(Stream.from(sort).map((item) => item.attribute))
        .filter((f) => f !== "geometry")
        .unique()
        .toArray();

    if (outFields.length === 0) {
        outFields.push("*");
    } else if (!outFields.includes(idProperty)) {
        outFields.push(idProperty);
    }
    return {outFields};
}

// Maps pagination options (start and num).
function translatePagination(
    supportsPagination: boolean,
    maxRecordCount: number,
    opts: PaginationOptions | undefined
): Partial<Query> {
    const start = opts?.start;
    if (!supportsPagination) {
        if (start) {
            throw new Error(
                "agssearch/LayerStore: cannot handle the " +
                "'start' option because pagination is not supported by this service"
            );
        }
        return {};
    }

    const num = Math.min(opts?.count ?? maxRecordCount, maxRecordCount);
    if (!start) {
        return {num};
    }
    return {start, num};
}

// Maps [{ attribute: "foo", descending: true }] to ["foo DESC"].
function translateSort(sort: SortOptions["sort"]): Partial<Query> | undefined {
    if (!sort) {
        return undefined;
    }

    const orderByFields = sort.map(({attribute, descending}) => attribute + (descending ? " DESC" : " ASC")) ?? [];
    return {orderByFields};
}

// Translates geometry options, e.g. spatial reference.
// Geometry is fetched if geometry options are set or if the geometry field is requested.
function translateGeometry(defaultEnabled: boolean, geometry: GeometryOptions | undefined): Partial<Query> | undefined {
    const result: Partial<Query> = {};
    result.returnGeometry = defaultEnabled || !!geometry;
    if (geometry?.maxAllowableOffset != null) {
        result.maxAllowableOffset = geometry.maxAllowableOffset;
    }
    if (geometry?.sr != null) {
        result.outSpatialReference = geometry.sr as any; // autocast
    }
    return result;
}

function parseMetadata(layer: SimpleFeatureLayer): LayerStoreMetadata {
    if (!layer.loaded) {
        throw new Error("internal error: layer must be loaded");
    }

    const {title, objectIdField: idProperty, displayField, fullExtent} = layer;
    const description: string = layer.sourceJSON?.description ?? "";
    const capabilities = layer.capabilities;
    if (!capabilities.operations.supportsQuery) {
        throw new Error("agssearch/LayerStore: layer does not support query operations");
    }

    const maxRecordCount = capabilities.query.maxRecordCount;
    const supportsGeometry = !!layer.geometryType;
    const supportsPagination = capabilities.query.supportsPagination;
    const supportsSorting = capabilities.query.supportsOrderBy;
    const fields = layer.fields.map((f): FieldData => {
        const name = f.name;
        const title = f.alias;
        const domain = f.domain;
        let {type, precision, identifier} = normalizeFieldType(f.type); // eslint-disable-line prefer-const
        if (idProperty && idProperty === name) {
            identifier = true;
        }

        return Object.freeze({
            name,
            type,
            title,
            identifier,
            precision,
            domain // TODO: not specified but currently needed for domain value resolving
        });
    });

    return Object.freeze({
        idProperty,
        title,
        displayField,
        description,
        fields,
        supportsGeometry,
        supportsSorting,
        fullExtent,
        supportsPagination,
        maxRecordCount,

        // TODO: not specified but currently needed for domain value resolving
        types: layer.sourceJSON?.types,
        typeIdField: layer.sourceJSON?.typeIdField
    });
}

function onlyRequestsIdProperty(idProperty: string, fields: QueryOptions["fields"]) {
    if (!fields || !fields[idProperty]) {
        return false;
    }

    const otherFields = Stream.entries(fields)
        .filterMap(([k, v]) => (v ? k : undefined))
        .filter((k) => k !== idProperty)
        .count();
    return otherFields === 0;
}

function toFeature(graphic: Graphic): Feature {
    const attrs = Object.assign({}, graphic.attributes);
    if (graphic.geometry) {
        attrs.geometry = graphic.geometry;
    }
    if (graphic.symbol) {
        attrs.symbol = graphic.symbol;
    }
    return attrs;
}

function normalizeFieldType(type: Field["type"]): Partial<FieldData> & Pick<FieldData, "type"> {
    switch (type) {
        case "single":
            return {type: "number", precision: "single"};
        case "double":
            return {type: "number", precision: "double"};
        case "long":
            return {type: "number", precision: "long"};
        case "small-integer":
            return {type: "number", precision: "smallinteger"};
        case "integer":
            return {type: "number", precision: "integer"};
        case "oid":
            return {type: "number", precision: "biginteger", identifier: true};
        default:
            return {type: type};
    }
}

// Ensure that there is always an abort signal to support the legacy API (CancelablePromise).
// If a signal is present, do nothing and pass it to the ArcGIS API.
// If no signal is present, create a new one and cancel it through the returned CancelablePromise.
function createCancelableOptions<T extends AbortOptions>(options?: T | undefined) {
    let aborter;
    let signal;
    if (options?.signal) {
        signal = options.signal;
    } else {
        aborter = new AbortController();
        signal = aborter.signal;
    }
    return {
        aborter,
        options: Object.assign({}, options, {signal})
    };
}

function createLegacyPromise<T>(aborter: AbortController | undefined, promise: Promise<T>) {
    return new CancelablePromise<T>((resolve, reject, oncancel) => {
        oncancel(() => aborter?.abort());
        promise.then(resolve, reject);
    });
}

function truncateResults<T>(results: T[], count: QueryOptions["count"]) {
    if (count == null) {
        return results;
    }
    return results.slice(0, count);
}

function identity<T>(value: T) {
    return value;
}

function merge<T>(instance: T, ...opts: (Partial<T> | null | undefined | false)[]): T {
    for (const opt of opts) {
        if (opt) {
            Object.assign(instance, opt);
        }
    }
    return instance;
}
