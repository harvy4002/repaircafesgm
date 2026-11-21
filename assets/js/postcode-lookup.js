// Postcode lookup: sorts the repair cafe table by distance from a visitor's
// postcode or current location. Uses postcodes.io (free, no API key).
(function () {
  var API = 'https://api.postcodes.io';
  var POSTCODE_RE = /([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})/gi;

  function findTable() {
    var tables = document.querySelectorAll('#main_content table');
    for (var i = 0; i < tables.length; i++) {
      var headers = tables[i].querySelectorAll('thead th');
      for (var j = 0; j < headers.length; j++) {
        if (headers[j].textContent.trim().toLowerCase() === 'address') {
          return { table: tables[i], addressCol: j };
        }
      }
    }
    return null;
  }

  function extractPostcode(text) {
    var matches = text.match(POSTCODE_RE);
    if (!matches) return null;
    return matches[matches.length - 1].replace(/\s+/g, '').toUpperCase();
  }

  function milesBetween(a, b) {
    var R = 3958.8;
    var toRad = function (d) { return d * Math.PI / 180; };
    var dLat = toRad(b.lat - a.lat);
    var dLon = toRad(b.lon - a.lon);
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function init() {
    var found = findTable();
    if (!found || !window.fetch) return;
    var table = found.table;
    var tbody = table.querySelector('tbody');
    var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr'));

    var cafes = rows.map(function (row, index) {
      var cell = row.children[found.addressCol];
      return {
        row: row,
        index: index,
        postcode: cell ? extractPostcode(cell.textContent) : null,
        coords: null
      };
    });

    // Distance column (hidden until a search is made)
    var th = document.createElement('th');
    th.textContent = 'Distance';
    th.className = 'distance-col';
    table.querySelector('thead tr').appendChild(th);
    cafes.forEach(function (cafe) {
      var td = document.createElement('td');
      td.className = 'distance-col';
      cafe.row.appendChild(td);
      cafe.distanceCell = td;
    });

    // Search form
    var form = document.createElement('form');
    form.className = 'postcode-lookup';
    form.setAttribute('role', 'search');
    form.innerHTML =
      '<label for="postcode-input">Find your nearest repair cafe</label>' +
      '<div class="postcode-lookup-controls">' +
      '<input id="postcode-input" type="text" autocomplete="postal-code" placeholder="Enter your postcode, e.g. M1 1AE">' +
      '<button type="submit">Search</button>' +
      ('geolocation' in navigator ? '<button type="button" class="postcode-geo">Use my location</button>' : '') +
      '<button type="button" class="postcode-reset" hidden>Reset</button>' +
      '</div>' +
      '<p class="postcode-status" aria-live="polite"></p>';
    table.parentNode.insertBefore(form, table);

    var input = form.querySelector('#postcode-input');
    var status = form.querySelector('.postcode-status');
    var resetBtn = form.querySelector('.postcode-reset');
    var geoBtn = form.querySelector('.postcode-geo');

    function setStatus(msg, isError) {
      status.textContent = msg;
      status.classList.toggle('postcode-error', !!isError);
    }

    function fetchCoords(path) {
      return fetch(API + path)
        .then(function (r) { if (!r.ok) throw new Error('not-found'); return r.json(); })
        .then(function (data) {
          if (!data.result) throw new Error('not-found');
          return { lat: data.result.latitude, lon: data.result.longitude };
        });
    }

    var cafeCoordsPromise = null;
    function loadCafeCoords() {
      if (cafeCoordsPromise) return cafeCoordsPromise;
      var postcodes = cafes.map(function (c) { return c.postcode; }).filter(Boolean);
      cafeCoordsPromise = fetch(API + '/postcodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postcodes: postcodes.slice(0, 100) })
      })
        .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
        .then(function (data) {
          var lookup = {};
          data.result.forEach(function (item) {
            if (item.result) {
              lookup[item.query.replace(/\s+/g, '').toUpperCase()] =
                { lat: item.result.latitude, lon: item.result.longitude };
            }
          });
          cafes.forEach(function (c) { c.coords = c.postcode ? lookup[c.postcode] || null : null; });
          // Fall back for retired postcodes, then the outward code (e.g. "M33")
          return Promise.all(cafes.filter(function (c) { return c.postcode && !c.coords; }).map(function (c) {
            return fetchCoords('/terminated_postcodes/' + c.postcode)
              .catch(function () { return fetchCoords('/outcodes/' + c.postcode.slice(0, -3)); })
              .then(function (coords) { c.coords = coords; })
              .catch(function () {});
          }));
        })
        .catch(function (err) { cafeCoordsPromise = null; throw err; });
      return cafeCoordsPromise;
    }

    function lookupPostcode(raw) {
      var pc = encodeURIComponent(raw.replace(/\s+/g, '').toUpperCase());
      // Full postcode first, then a partial one such as "M21"
      return fetchCoords('/postcodes/' + pc).catch(function () {
        return fetchCoords('/outcodes/' + pc);
      });
    }

    function sortFrom(origin, label) {
      setStatus('Finding nearby repair cafes…');
      return loadCafeCoords().then(function () {
        cafes.forEach(function (c) {
          c.distance = c.coords ? milesBetween(origin, c.coords) : Infinity;
          c.distanceCell.textContent = isFinite(c.distance) ? c.distance.toFixed(1) + ' miles' : '–';
        });
        cafes.slice().sort(function (a, b) { return a.distance - b.distance || a.index - b.index; })
          .forEach(function (c) { tbody.appendChild(c.row); });
        table.classList.add('show-distance');
        resetBtn.hidden = false;
        setStatus('Sorted by distance from ' + label + '. Distances are as the crow flies.');
      });
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var value = input.value.trim();
      if (!value) { setStatus('Please enter a postcode.', true); return; }
      setStatus('Looking up ' + value.toUpperCase() + '…');
      lookupPostcode(value)
        .then(function (origin) { return sortFrom(origin, value.toUpperCase()); })
        .catch(function (err) {
          setStatus(err && err.message === 'not-found'
            ? "Sorry, we couldn't find that postcode. Please check it and try again."
            : 'Sorry, the postcode lookup is not available right now. Please try again later.', true);
        });
    });

    if (geoBtn) {
      geoBtn.addEventListener('click', function () {
        setStatus('Getting your location…');
        navigator.geolocation.getCurrentPosition(function (pos) {
          sortFrom({ lat: pos.coords.latitude, lon: pos.coords.longitude }, 'your location')
            .catch(function () { setStatus('Sorry, the lookup is not available right now. Please try again later.', true); });
        }, function () {
          setStatus("We couldn't get your location. Try entering your postcode instead.", true);
        }, { timeout: 10000, maximumAge: 600000 });
      });
    }

    resetBtn.addEventListener('click', function () {
      cafes.forEach(function (c) { tbody.appendChild(c.row); c.distanceCell.textContent = ''; });
      table.classList.remove('show-distance');
      resetBtn.hidden = true;
      input.value = '';
      setStatus('');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
