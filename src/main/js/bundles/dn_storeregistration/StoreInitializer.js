import Promise from "apprt-core/Promise";
import Filter from "ct/store/Filter";

function _findField({ fields }, name) {
    let returnField;
    fields &&
        fields.some((field) => {
            if (field.name === name) {
                returnField = field;
                return true;
            }
        });
    return returnField;
}

function _findDefaultSearchField(metadata) {
    const { displayField } = metadata;
    const searchField = _findField(metadata, displayField);
    if (!searchField) {
        return;
    }
    if (searchField.type !== "string") {
        return;
    }
    return searchField;
}

function _parseMetadata(nonFilteredStore, metadata, props, defaults) {
    const query = props.filterQuery || {};
    const opts = props.filterOptions || {};
    // do not use Filter if no filterQuery or query options are declared
    const filterStore =
        Object.keys(query).length || Object.keys(opts).length
            ? Filter(nonFilteredStore, query, opts)
            : nonFilteredStore;
    if (!props.title) {
        props.title = metadata.title || metadata.name || defaults.name;
    }
    if (!props.description) {
        props.description = metadata.description || defaults.description;
    }
    // TODO: search-ui?
    if (props.useIn && props.useIn.indexOf("omnisearch") > -1) {
        if (!props.omniSearchSearchAttr) {
            const searchField = _findDefaultSearchField(metadata);
            if (!searchField) {
                console.warn("no string field found in mapserver store '" + nonFilteredStore.id + "'!");
            } else {
                props.omniSearchSearchAttr = searchField.name;
                props.omniSearchDefaultLabel = props.omniSearchDefaultLabel || searchField.title || searchField.name;
            }
        }
        if (!props.omniSearchDefaultLabel) {
            const field = _findField(metadata, props.omniSearchSearchAttr);
            if (field) {
                props.omniSearchDefaultLabel = field.title || field.name;
            }
        }
    }
    return { store: filterStore, nonFilteredStore, props };
}

export function StoreInitializer(opts) {
    const fac = opts.fac;
    if (!fac) {
        throw new Error("missing 'fac' option, the ags store factory!");
    }
    const defaults = opts.defaults || {};

    return {
        async init(props) {
            props = Object.assign({}, props || {});

            const { id, idProperty, idField, legacyImplementation } = props;
            const target = props.url || props.target;
            if (!target && !props.layerId) {
                const msg = `Missing 'url' or 'layerId' for store ' ${id} '! `;
                return Promise.reject(new Error(msg));
            }

            const params = {
                target,
                idProperty: idProperty || idField || "OBJECTID",
                legacyImplementation
            };

            // ensure that not null/undefined properties are transported into constructor
            [
                "id",
                "layerId",
                "type",
                "fetchIdProperty",
                "disableIdQueries",
                "enablePagination",
                "enableObjectIdsQueries"
            ].forEach((name) => {
                const val = props[name];
                if (val !== null && val !== undefined) {
                    params[name] = val;
                }
            });

            let store;
            try {
                store = await fac.createStore(params);
                const metadata = await store.getMetadata();
                return _parseMetadata(store, metadata, props, defaults);
            } catch (e) {
                store?.destroy?.();
                throw e;
            }
        }
    };
}
