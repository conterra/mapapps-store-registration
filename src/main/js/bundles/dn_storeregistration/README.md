# dn_storeregistration

The Store Registration bundle allows to create stores based on additional layers. Supported layer types are geojson and csv.

## Usage
1. First you need to add the bundle dn_storeregistration to your app.
2. Then you can configure your stores.

## Configuration Reference

### AutoStoreRegistration

```json
"dn_storeregistration": {
    "AutoStoreRegistration": {
        "componentEnabled": true
    }
}
```

| Property         | Type    | Possible Values               | Default     | Description                                                  |
|------------------|---------|-------------------------------|-------------|--------------------------------------------------------------|
| componentEnabled | Boolean | ```true``` &#124; ```false``` | ```false``` | Enable the AutoStoreRegistration for geojson and csv layers. |

### LayerStore

You can create stores by _layerId_ or _url_. Only geojson and csv layer types are supported.

#### By _layerId_

```json
"dn_storeregistration": {
    "LayerStore": [
        {
            "id": "earthquakes_geojson_store_layer",
            "title": "Earthquakes Store GeoJSON URL",
            "description": "Earthquakes of the world",
            "layerId": "earthquakes_geojson_layer",
            "useIn": [
                "selection"
            ]
        }
    ]
}
```

#### By _url_

You need to define the data type (_geojson_ or _csv_)!

```json
"dn_storeregistration": {
    "LayerStore": [
        {
            "id": "earthquakes_geojson_store_url",
            "title": "Earthquakes Store GeoJSON URL",
            "description": "Earthquakes of the world",
            "url": "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_month.geojson",
            "type": "geojson",
            "useIn": [
                "selection"
            ]
        }
    ]
}
```
