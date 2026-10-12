#!/bin/sh
# Downloads the landmark lists from Wikidata into ./raw. Run from the repo root.
UA='User-Agent: 10RandomPins-build/1.0 (https://github.com/10randompins)'
q() { curl -sS -m 300 -G https://query.wikidata.org/sparql -H "$UA" -H 'Accept: text/csv' --data-urlencode "query=$1" -o "raw/$2"; }
q 'SELECT ?item ?coord ?c ?label WHERE { ?item wdt:P757 ?id; wdt:P625 ?coord; wdt:P17 ?c. OPTIONAL { ?item rdfs:label ?label FILTER(lang(?label)="en") } }' unesco.csv
q 'SELECT ?c ?iso WHERE { ?c wdt:P297 ?iso }' iso.csv
q 'SELECT ?item ?coord ?c ?label ?sl WHERE { ?item wdt:P31 wd:Q46169; wdt:P625 ?coord; wdt:P17 ?c; wikibase:sitelinks ?sl. FILTER(?sl >= 8) OPTIONAL { ?item rdfs:label ?label FILTER(lang(?label)="en") } }' parks.csv
q 'SELECT ?item ?coord ?c ?label ?sl WHERE { ?item wdt:P31 wd:Q570116; wdt:P625 ?coord; wdt:P17 ?c; wikibase:sitelinks ?sl. FILTER(?sl >= 8) OPTIONAL { ?item rdfs:label ?label FILTER(lang(?label)="en") } }' attractions.csv
