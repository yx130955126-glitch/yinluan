/*:
 * @target MV MZ
 * @plugindesc Optional local translations.json runtime translator (fail-open).
 * @author ACG
 *
 * @param fileName
 * @text Translation JSON
 * @type string
 * @default translations.json
 *
 * @param timeoutMs
 * @text Load timeout (ms)
 * @type number
 * @min 1000
 * @max 30000
 * @default 8000
 *
 * @param cacheSize
 * @text Translation cache size
 * @type number
 * @min 128
 * @max 65536
 * @default 4096
 *
 * @param minSubstringLength
 * @text Minimum fragment source length
 * @type number
 * @min 1
 * @max 128
 * @default 2
 *
 * @help
 * Loads an optional UTF-8 JSON object from the game www root:
 *
 *   {
 *     "Japanese text": "Translated text"
 *   }
 *
 * Missing files, local-file errors, HTTP errors and invalid JSON disable this
 * plugin without interrupting game startup. It prefers an exact match, then
 * applies dictionary fragments from longest to shortest on each displayed
 * line. When a translated multiline entry has the same number of source and
 * target lines, unambiguous corresponding lines longer than three characters
 * are also indexed for exact display-time matching. Explicit translations take
 * priority over these derived lines. minSubstringLength affects fragment
 * replacement only; shorter keys remain available for exact whole-text,
 * exact per-line, and exact visible segments between protected control codes.
 * The same minimum also prevents Bitmap's per-character draw and width-measure
 * paths from treating one-character dictionary keys as standalone UI strings.
 * Automatic translation is limited to message startup and display-only window
 * methods. Window_Base and plugin-defined Window_* subclasses are scanned at
 * install time and again when the database becomes ready, so a plugin's own
 * drawTextEx/drawText override still receives translated text.
 * Window_Base.convertEscapeCharacters is hooked globally in a protected mode
 * so custom dialogue windows are also covered. Runtime/resource identifiers
 * such as asset paths and filenames are detected and left untouched.
 */

(function() {
    "use strict";

    if (typeof window === "undefined") {
        return;
    }

    var PLUGIN_NAME = "OptionalJsonTranslation";
    var INSTALL_GUARD = "__OptionalJsonTranslationInstalled";
    var DISPLAY_WRAPPER_MARK =
        "__OptionalJsonTranslationDisplayWrapper";
    var DISPLAY_WRAPPER_ORIGINAL =
        "__OptionalJsonTranslationDisplayOriginal";
    var INSTANCE_DISCOVERY_MARK =
        "__OptionalJsonTranslationInstanceDiscovery";
    var WINDOW_DISPLAY_METHODS = [
        { name: "drawTextEx", translateEscapes: true },
        { name: "drawText", translateEscapes: false }
    ];

    if (window[INSTALL_GUARD]) {
        return;
    }
    window[INSTALL_GUARD] = true;

    var STATE_LOADING = "loading";
    var STATE_READY = "ready";
    var STATE_DISABLED = "disabled";
    var HAS_OWN = Object.prototype.hasOwnProperty;
    var OBJECT_TO_STRING = Object.prototype.toString;
    var CONTROL_TOKEN_PATTERN = /(?:(?:\\|\x1b)(?:[A-Za-z]+(?:\[[^\]]*\])?|[{}$.|!><^]|\\))|%\d+|\{\d+\}/g;
    var PROTECTED_DISPLAY_TOKEN_PATTERN = /(?:(?:\\|\x1b)(?:[A-Za-z]+(?:\[[^\]]*\])?|[{}$.|!><^]|\\))|%\d+|\{\d+\}|<[^>\r\n]*>/g;
    var CACHE_TEXT_LIMIT = 4096;

    var parameters = readParameters();
    var fileName = String(parameters.fileName || "translations.json");
    var timeoutMs = boundedInteger(parameters.timeoutMs, 8000, 1000, 30000);
    var maxCacheEntries = boundedInteger(
        parameters.cacheSize,
        4096,
        128,
        65536
    );
    var minSubstringLength = boundedInteger(
        parameters.minSubstringLength,
        2,
        1,
        128
    );

    var state = STATE_LOADING;
    var translations = Object.create(null);
    var translatedValues = Object.create(null);
    var normalizedTranslations = Object.create(null);
    var normalizedTranslatedValues = Object.create(null);
    var translationKeysByLength = Object.create(null);
    var translationKeyLengths = [];
    var translationCache = Object.create(null);
    var translationCacheSize = 0;
    var translationEntryCount = 0;
    var loadWatchdog = null;
    var displayHooksRefreshedAfterLoad = false;

    window.OptionalJsonTranslation = {
        getState: function() {
            return state;
        },
        isEnabled: function() {
            return state === STATE_READY;
        },
        getEntryCount: function() {
            return translationEntryCount;
        },
        // MTool-compatible public entry point used by its MV/MZ hooks.
        fixInStrToTrsNR: function(text) {
            return translateText(text);
        },
        translate: function(text) {
            return translateText(text);
        },
        refreshDisplayHooks: function() {
            installWindowDisplayHooks();
        }
    };

    installRuntimeHooks();
    startLoading();

    function readParameters() {
        var parameters = {};
        var pluginParameters;
        var directConfig;
        var key;

        if (typeof PluginManager !== "undefined" &&
                typeof PluginManager.parameters === "function") {
            try {
                pluginParameters = PluginManager.parameters(PLUGIN_NAME) || {};
                for (key in pluginParameters) {
                    if (hasOwn(pluginParameters, key)) {
                        parameters[key] = pluginParameters[key];
                    }
                }
            } catch (error) {
                logInfo("Unable to read plugin parameters; defaults will be used.");
            }
        }

        // Merged-script builds disable PluginManager.loadScript and keep the
        // plugin array inside a bundled game.js. In that mode index.html loads
        // this file directly and supplies the same parameters through a small
        // configuration object immediately before this script tag.
        directConfig = window.OptionalJsonTranslationConfig;
        if (directConfig && typeof directConfig === "object") {
            for (key in directConfig) {
                if (hasOwn(directConfig, key)) {
                    parameters[key] = directConfig[key];
                }
            }
        }
        return parameters;
    }

    function boundedInteger(value, fallback, minimum, maximum) {
        var number = parseInt(value, 10);
        if (!isFinite(number)) {
            number = fallback;
        }
        if (number < minimum) {
            number = minimum;
        }
        if (number > maximum) {
            number = maximum;
        }
        return number;
    }

    function logInfo(message) {
        if (typeof console !== "undefined" &&
                typeof console.info === "function") {
            console.info("[" + PLUGIN_NAME + "] " + message);
        }
    }

    function logWarning(message) {
        if (typeof console !== "undefined" &&
                typeof console.warn === "function") {
            console.warn("[" + PLUGIN_NAME + "] " + message);
        } else {
            logInfo(message);
        }
    }

    function hasOwn(object, key) {
        return HAS_OWN.call(object, key);
    }

    function normalizeNewlines(text) {
        return String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    }

    function normalizeMessageWhitespace(text) {
        return normalizeNewlines(text)
            .replace(/[ \t]*\n[ \t]*/g, " ")
            .replace(/[ \t]+/g, " ")
            .replace(/^ | $/g, "");
    }

    function normalizeControlToken(token) {
        var normalized = token;
        if (normalized.charAt(0) === "\x1b") {
            normalized = "\\" + normalized.slice(1);
        }
        if (normalized.charAt(0) === "\\") {
            normalized = normalized.replace(
                /^\\([A-Za-z]+)/,
                function(match, commandName) {
                    return "\\" + commandName.toUpperCase();
                }
            );
        }
        return normalized;
    }

    function controlSignature(text) {
        var tokens = String(text).match(CONTROL_TOKEN_PATTERN) || [];
        var index;
        for (index = 0; index < tokens.length; index += 1) {
            tokens[index] = normalizeControlToken(tokens[index]);
        }
        tokens.sort();
        return tokens.join("\u0001");
    }

    function isPlainJsonObject(value) {
        return value !== null &&
            OBJECT_TO_STRING.call(value) === "[object Object]";
    }

    function buildTranslationTable(sourceObject) {
        var nextTranslations = Object.create(null);
        var nextTranslatedValues = Object.create(null);
        var nextNormalizedTranslations = Object.create(null);
        var nextNormalizedTranslatedValues = Object.create(null);
        var ambiguousNormalizedSources = Object.create(null);
        var explicitNormalizedSources = Object.create(null);
        var derivedTranslations = Object.create(null);
        var ambiguousDerivedSources = Object.create(null);
        var keys = Object.keys(sourceObject);
        var acceptedCount;
        var skippedIdentityCount = 0;
        var rejectedControlCount = 0;
        var rejectedDerivedControlCount = 0;
        var derivedCount = 0;
        var ambiguousDerivedCount = 0;
        var nextKeysByLength = Object.create(null);
        var nextKeyLengths;
        var explicitKeys;
        var acceptedDerivedKeys = [];
        var index;

        function recordDerivedTranslation(sourceLine, targetLine) {
            if (hasOwn(ambiguousDerivedSources, sourceLine)) {
                return;
            }
            if (!hasOwn(derivedTranslations, sourceLine)) {
                derivedTranslations[sourceLine] = targetLine;
                return;
            }
            if (derivedTranslations[sourceLine] !== targetLine) {
                delete derivedTranslations[sourceLine];
                ambiguousDerivedSources[sourceLine] = true;
            }
        }

        function addNormalizedTranslation(sourceText, targetText) {
            var normalizedSource = normalizeMessageWhitespace(sourceText);
            if (hasOwn(ambiguousNormalizedSources, normalizedSource)) {
                return;
            }
            if (!hasOwn(nextNormalizedTranslations, normalizedSource) ||
                    nextNormalizedTranslations[normalizedSource] ===
                    targetText) {
                nextNormalizedTranslations[normalizedSource] = targetText;
            } else {
                delete nextNormalizedTranslations[normalizedSource];
                ambiguousNormalizedSources[normalizedSource] = true;
            }
        }

        for (index = 0; index < keys.length; index += 1) {
            var sourceText = normalizeNewlines(keys[index]);
            var targetValue = sourceObject[keys[index]];
            var targetText;
            var sourceLines;
            var targetLines;
            var lineIndex;
            var sourceLine;
            var targetLine;

            if (!sourceText || typeof targetValue !== "string") {
                continue;
            }

            targetText = normalizeNewlines(targetValue);
            if (sourceText === targetText) {
                skippedIdentityCount += 1;
                continue;
            }
            if (controlSignature(sourceText) !== controlSignature(targetText)) {
                rejectedControlCount += 1;
                continue;
            }

            nextTranslations[sourceText] = targetText;

            if (sourceText.indexOf("\n") >= 0) {
                sourceLines = sourceText.split("\n");
                targetLines = targetText.split("\n");
                if (sourceLines.length === targetLines.length) {
                    for (lineIndex = 0;
                            lineIndex < sourceLines.length;
                            lineIndex += 1) {
                        sourceLine = sourceLines[lineIndex];
                        targetLine = targetLines[lineIndex];
                        if (sourceLine.length <= 3 ||
                                !/\S/.test(sourceLine) ||
                                !/\S/.test(targetLine) ||
                                sourceLine === targetLine) {
                            continue;
                        }
                        if (controlSignature(sourceLine) !==
                                controlSignature(targetLine)) {
                            rejectedDerivedControlCount += 1;
                            continue;
                        }
                        recordDerivedTranslation(sourceLine, targetLine);
                    }
                }
            }
        }

        explicitKeys = Object.keys(nextTranslations);
        keys = Object.keys(derivedTranslations);
        for (index = 0; index < keys.length; index += 1) {
            if (hasOwn(nextTranslations, keys[index])) {
                continue;
            }
            nextTranslations[keys[index]] = derivedTranslations[keys[index]];
            acceptedDerivedKeys.push(keys[index]);
            derivedCount += 1;
        }

        keys = Object.keys(ambiguousDerivedSources);
        for (index = 0; index < keys.length; index += 1) {
            if (!hasOwn(nextTranslations, keys[index])) {
                ambiguousDerivedCount += 1;
            }
        }

        for (index = 0; index < explicitKeys.length; index += 1) {
            var explicitSource = explicitKeys[index];
            var explicitTarget = nextTranslations[explicitSource];
            var explicitNormalizedSource =
                normalizeMessageWhitespace(explicitSource);

            nextTranslatedValues[explicitTarget] = true;
            nextNormalizedTranslatedValues[
                normalizeMessageWhitespace(explicitTarget)
            ] = true;
            explicitNormalizedSources[explicitNormalizedSource] = true;
            addNormalizedTranslation(explicitSource, explicitTarget);
        }

        for (index = 0; index < acceptedDerivedKeys.length; index += 1) {
            var derivedSource = acceptedDerivedKeys[index];
            var derivedTarget = nextTranslations[derivedSource];
            var derivedNormalizedSource =
                normalizeMessageWhitespace(derivedSource);

            nextTranslatedValues[derivedTarget] = true;
            nextNormalizedTranslatedValues[
                normalizeMessageWhitespace(derivedTarget)
            ] = true;
            // A normalized form supplied by an explicit valid entry always
            // wins, even when a differently-spaced derived line also exists.
            if (!hasOwn(explicitNormalizedSources, derivedNormalizedSource)) {
                addNormalizedTranslation(derivedSource, derivedTarget);
            }
        }

        keys = Object.keys(nextTranslations);
        acceptedCount = keys.length;
        for (index = 0; index < keys.length; index += 1) {
            var keyLength = keys[index].length;
            if (keyLength < minSubstringLength) {
                continue;
            }
            if (!hasOwn(nextKeysByLength, keyLength)) {
                nextKeysByLength[keyLength] = [];
            }
            nextKeysByLength[keyLength].push(keys[index]);
        }
        nextKeyLengths = Object.keys(nextKeysByLength).map(function(length) {
            return parseInt(length, 10);
        }).sort(function(left, right) {
            return right - left;
        });

        return {
            translations: nextTranslations,
            translatedValues: nextTranslatedValues,
            normalizedTranslations: nextNormalizedTranslations,
            normalizedTranslatedValues: nextNormalizedTranslatedValues,
            translationKeysByLength: nextKeysByLength,
            translationKeyLengths: nextKeyLengths,
            acceptedCount: acceptedCount,
            skippedIdentityCount: skippedIdentityCount,
            rejectedControlCount: rejectedControlCount,
            rejectedDerivedControlCount: rejectedDerivedControlCount,
            derivedCount: derivedCount,
            ambiguousDerivedCount: ambiguousDerivedCount
        };
    }

    function clearLoadWatchdog() {
        if (loadWatchdog !== null && typeof clearTimeout === "function") {
            clearTimeout(loadWatchdog);
        }
        loadWatchdog = null;
    }

    function settleReady(tableResult) {
        if (state !== STATE_LOADING) {
            return;
        }

        clearLoadWatchdog();
        translations = tableResult.translations;
        translatedValues = tableResult.translatedValues;
        normalizedTranslations = tableResult.normalizedTranslations;
        normalizedTranslatedValues = tableResult.normalizedTranslatedValues;
        translationKeysByLength = tableResult.translationKeysByLength;
        translationKeyLengths = tableResult.translationKeyLengths;
        translationEntryCount = tableResult.acceptedCount;
        state = STATE_READY;

        if (tableResult.rejectedControlCount > 0) {
            logWarning(
                "Skipped " + tableResult.rejectedControlCount +
                " entries whose control codes or placeholders changed."
            );
        }
        if (tableResult.skippedIdentityCount > 0) {
            logInfo(
                "Skipped " + tableResult.skippedIdentityCount +
                " identity entries."
            );
        }
        if (tableResult.derivedCount > 0) {
            logInfo(
                "Added " + tableResult.derivedCount +
                " unambiguous line-derived entries."
            );
        }
        if (tableResult.ambiguousDerivedCount > 0) {
            logWarning(
                "Skipped " + tableResult.ambiguousDerivedCount +
                " ambiguous line-derived sources."
            );
        }
        if (tableResult.rejectedDerivedControlCount > 0) {
            logWarning(
                "Skipped " + tableResult.rejectedDerivedControlCount +
                " derived lines whose control codes or placeholders changed."
            );
        }
        logInfo("Loaded " + translationEntryCount + " translation entries.");
    }

    function settleDisabled(reason) {
        if (state !== STATE_LOADING) {
            return;
        }

        clearLoadWatchdog();
        state = STATE_DISABLED;
        translations = Object.create(null);
        translatedValues = Object.create(null);
        normalizedTranslations = Object.create(null);
        normalizedTranslatedValues = Object.create(null);
        translationKeysByLength = Object.create(null);
        translationKeyLengths = [];
        translationEntryCount = 0;
        clearTranslationCache();
        logInfo(reason + " Translation disabled; the game will continue normally.");
    }

    function startLoading() {
        var request;

        if (typeof XMLHttpRequest === "undefined") {
            settleDisabled("XMLHttpRequest is unavailable.");
            return;
        }

        if (typeof setTimeout === "function") {
            loadWatchdog = setTimeout(function() {
                settleDisabled("Translation file load timed out.");
            }, timeoutMs);
        }

        try {
            request = new XMLHttpRequest();
            request.open("GET", fileName, true);

            if (typeof request.overrideMimeType === "function") {
                try {
                    request.overrideMimeType("application/json; charset=utf-8");
                } catch (mimeError) {
                    // Some old WebViews expose overrideMimeType but reject it.
                }
            }

            try {
                request.timeout = timeoutMs;
            } catch (timeoutError) {
                // The independent watchdog still guarantees fail-open behavior.
            }

            request.onload = function() {
                var status;
                var responseText;
                var localFileSuccess;
                var httpSuccess;
                var parsed;
                var tableResult;

                if (state !== STATE_LOADING) {
                    return;
                }

                try {
                    status = Number(request.status) || 0;
                    responseText = request.responseText || "";
                    httpSuccess = status >= 200 && status < 400;
                    localFileSuccess = status === 0 && responseText.length > 0;

                    if (!httpSuccess && !localFileSuccess) {
                        settleDisabled("Translation file is missing or unreadable.");
                        return;
                    }

                    if (responseText.charCodeAt(0) === 0xfeff) {
                        responseText = responseText.slice(1);
                    }

                    parsed = JSON.parse(responseText);
                    if (!isPlainJsonObject(parsed)) {
                        settleDisabled("Translation JSON root is not an object.");
                        return;
                    }

                    tableResult = buildTranslationTable(parsed);
                    settleReady(tableResult);
                } catch (loadError) {
                    settleDisabled("Translation JSON is invalid or unreadable.");
                }
            };

            request.onerror = function() {
                settleDisabled("Translation file request failed.");
            };
            request.onabort = function() {
                settleDisabled("Translation file request was aborted.");
            };
            request.ontimeout = function() {
                settleDisabled("Translation file request timed out.");
            };

            request.send(null);
        } catch (requestError) {
            // Android WebView may throw NetworkError directly from send() when a
            // file:///android_asset resource does not exist.
            settleDisabled("Translation file is missing or unreadable.");
        }
    }

    function clearTranslationCache() {
        translationCache = Object.create(null);
        translationCacheSize = 0;
    }

    function readCachedTranslation(text) {
        if (text.length > CACHE_TEXT_LIMIT || !hasOwn(translationCache, text)) {
            return null;
        }
        return {
            found: true,
            value: translationCache[text]
        };
    }

    function cacheTranslation(text, translatedText) {
        if (text.length > CACHE_TEXT_LIMIT) {
            return;
        }
        if (translationCacheSize >= maxCacheEntries) {
            clearTranslationCache();
        }
        if (!hasOwn(translationCache, text)) {
            translationCacheSize += 1;
        }
        translationCache[text] = translatedText;
    }

    function translateExactNormalized(text) {
        var leadingWhitespace;
        var body;
        var normalizedLookup;

        if (hasOwn(translatedValues, text)) {
            return text;
        }
        if (hasOwn(translations, text)) {
            return translations[text];
        }

        leadingWhitespace = /^([ \t]+)([\s\S]+)$/.exec(text);
        if (leadingWhitespace) {
            body = leadingWhitespace[2];
            if (hasOwn(translatedValues, body)) {
                return text;
            }
            if (hasOwn(translations, body)) {
                return leadingWhitespace[1] + translations[body];
            }
            normalizedLookup = normalizeMessageWhitespace(body);
            if (hasOwn(normalizedTranslatedValues, normalizedLookup)) {
                return text;
            }
            if (hasOwn(normalizedTranslations, normalizedLookup)) {
                return leadingWhitespace[1] +
                    normalizedTranslations[normalizedLookup];
            }
        }

        normalizedLookup = normalizeMessageWhitespace(text);
        if (hasOwn(normalizedTranslatedValues, normalizedLookup)) {
            return text;
        }
        if (hasOwn(normalizedTranslations, normalizedLookup)) {
            return normalizedTranslations[normalizedLookup];
        }
        return text;
    }

    function splitDisplaySegments(text) {
        var source = String(text);
        var segments = [];
        var lastIndex = 0;
        var match;

        PROTECTED_DISPLAY_TOKEN_PATTERN.lastIndex = 0;
        while ((match = PROTECTED_DISPLAY_TOKEN_PATTERN.exec(source)) !== null) {
            if (match.index > lastIndex) {
                segments.push({
                    text: source.slice(lastIndex, match.index),
                    protected: false
                });
            }
            segments.push({ text: match[0], protected: true });
            lastIndex = match.index + match[0].length;
            if (match[0].length === 0) {
                PROTECTED_DISPLAY_TOKEN_PATTERN.lastIndex += 1;
            }
        }
        if (lastIndex < source.length) {
            segments.push({
                text: source.slice(lastIndex),
                protected: false
            });
        }
        if (segments.length === 0) {
            segments.push({ text: source, protected: false });
        }
        PROTECTED_DISPLAY_TOKEN_PATTERN.lastIndex = 0;
        return segments;
    }

    function translateLongestSubstringsInVisibleText(text) {
        var result = text;
        var sourceLength = text.length;
        var lengthIndex;
        var keyIndex;
        var keyLength;
        var keys;
        var key;
        var matchIndex;

        for (lengthIndex = 0;
                lengthIndex < translationKeyLengths.length;
                lengthIndex += 1) {
            keyLength = translationKeyLengths[lengthIndex];
            if (keyLength > sourceLength) {
                continue;
            }
            keys = translationKeysByLength[keyLength];
            for (keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
                key = keys[keyIndex];
                // Replace every safe occurrence in one pass. Replacements
                // are not scanned again, so a target containing its own source
                // key cannot cause an infinite loop.
                var scanIndex = 0;
                var rebuilt = "";
                var occurrenceIndex;
                while (scanIndex <= result.length - key.length) {
                    occurrenceIndex = findSafeSubstringIndex(
                        result.slice(scanIndex), key
                    );
                    if (occurrenceIndex < 0) {
                        break;
                    }
                    occurrenceIndex += scanIndex;
                    rebuilt += result.slice(scanIndex, occurrenceIndex);
                    rebuilt += translations[key];
                    scanIndex = occurrenceIndex + key.length;
                }
                if (scanIndex > 0) {
                    rebuilt += result.slice(scanIndex);
                    result = rebuilt;
                }
            }
        }
        return result;
    }

    function translateLongestSubstrings(text) {
        var segments = splitDisplaySegments(text);
        var changed = false;
        var index;
        var translatedSegment;

        for (index = 0; index < segments.length; index += 1) {
            if (segments[index].protected || !segments[index].text) {
                continue;
            }
            translatedSegment = translateExactNormalized(segments[index].text);
            if (translatedSegment === segments[index].text) {
                translatedSegment = translateLongestSubstringsInVisibleText(
                    segments[index].text
                );
            }
            if (translatedSegment !== segments[index].text) {
                segments[index].text = translatedSegment;
                changed = true;
            }
        }
        if (!changed) {
            return text;
        }
        return segments.map(function(segment) {
            return segment.text;
        }).join("");
    }

    function translateExactVisibleSegments(text) {
        var segments = splitDisplaySegments(text);
        var changed = false;
        var index;
        var translatedSegment;

        for (index = 0; index < segments.length; index += 1) {
            if (segments[index].protected || !segments[index].text) {
                continue;
            }
            translatedSegment = translateExactNormalized(segments[index].text);
            if (translatedSegment !== segments[index].text) {
                segments[index].text = translatedSegment;
                changed = true;
            }
        }
        if (!changed) {
            return text;
        }
        return segments.map(function(segment) {
            return segment.text;
        }).join("");
    }

    function isAsciiWordCharacter(character) {
        return !!character && /[A-Za-z0-9_]/.test(character);
    }

    function findSafeSubstringIndex(text, key) {
        var needsEnglishBoundary = /[A-Za-z0-9_]/.test(key);
        var startIndex = 0;
        var matchIndex;
        var before;
        var after;

        while (startIndex <= text.length - key.length) {
            matchIndex = text.indexOf(key, startIndex);
            if (matchIndex < 0) {
                return -1;
            }
            if (!needsEnglishBoundary) {
                return matchIndex;
            }

            before = matchIndex > 0 ? text.charAt(matchIndex - 1) : "";
            after = matchIndex + key.length < text.length ?
                text.charAt(matchIndex + key.length) : "";
            if (!isAsciiWordCharacter(before) &&
                    !isAsciiWordCharacter(after)) {
                return matchIndex;
            }
            startIndex = matchIndex + 1;
        }
        return -1;
    }

    function translateLine(text) {
        var result = translateExactNormalized(text);
        if (result !== text) {
            return result;
        }
        return translateLongestSubstrings(text);
    }

    function translateMessageBodyBeforeLines(text) {
        var wrapped = /^((?:\\|\x1b)N(?:R)?<[^>]*>)([\s\S]+)$/i.exec(text);
        var header;
        var body;
        var translatedHeader;
        var translatedBody;

        if (!wrapped) {
            return text;
        }

        header = wrapped[1];
        body = wrapped[2];
        translatedHeader = translateSpeakerHeader(header);
        translatedBody = translateExactNormalized(body);
        if (translatedBody === body) {
            // MTool evaluates the complete message body before individual
            // command-401 lines. This lets a multiline dictionary key match
            // even when RPG Maker prepends a speaker/control-code header.
            translatedBody = translateLongestSubstrings(body);
        }
        if (translatedBody === body && translatedHeader === header) {
            return text;
        }
        return translatedHeader + translatedBody;
    }

    function translateSpeakerHeader(header) {
        var wrapped = /^((?:\\|\x1b)N(?:R)?<)([\s\S]*)(>)$/i.exec(header);
        var body;
        var translatedBody;

        if (!wrapped) {
            return header;
        }
        body = wrapped[2];
        translatedBody = translateLongestSubstrings(body);
        translatedBody = translateExactVisibleSegments(translatedBody);
        if (translatedBody === body) {
            return header;
        }
        return wrapped[1] + translatedBody + wrapped[3];
    }

    function translateColoredSegments(text) {
        var coloredSegmentPattern =
            /((?:\\|\x1b)C\[[^\]]*\])([^\\\x1b]*?)((?:\\|\x1b)C\[0\])([.!?,;:'"…]*)/gi;

        return String(text).replace(
            coloredSegmentPattern,
            function(match, openColor, body, closeColor, punctuation) {
                var punctuationLength;
                var candidate;
                var translatedCandidate;

                // Color reset codes commonly sit between a word and its
                // punctuation (for example: \\C[27]Cock\\C[0].). MTool treats
                // those codes as transparent while matching. Try the longest
                // visible word-plus-punctuation candidate first, then the
                // exact colored body. Short body keys are allowed here because
                // the color span itself provides a safe translation boundary.
                for (punctuationLength = punctuation.length;
                        punctuationLength >= 0;
                        punctuationLength -= 1) {
                    candidate = body + punctuation.slice(0, punctuationLength);
                    translatedCandidate = translateExactNormalized(candidate);
                    if (translatedCandidate !== candidate) {
                        return openColor + translatedCandidate + closeColor +
                            punctuation.slice(punctuationLength);
                    }
                }
                return match;
            }
        );
    }

    function cacheFinalTranslation(sourceText, translatedText) {
        var finalText = translateColoredSegments(translatedText);
        finalText = translateExactVisibleSegments(finalText);
        cacheTranslation(sourceText, finalText);
        return finalText;
    }

    function translateText(text) {
        var cached;
        var normalized;
        var result;
        var lines;
        var translatedLine;
        var changed = false;
        var index;

        if (state !== STATE_READY || typeof text !== "string" || !text) {
            return text;
        }

        cached = readCachedTranslation(text);
        if (cached !== null) {
            return cached.value;
        }

        normalized = normalizeNewlines(text);
        if (hasOwn(translatedValues, normalized)) {
            return cacheFinalTranslation(text, text);
        }

        result = translateExactNormalized(normalized);
        if (result !== normalized) {
            return cacheFinalTranslation(text, result);
        }

        // Color reset codes can split a visible word from its punctuation.
        // Resolve those explicit display spans before ordinary visible-segment
        // matching so a longer "word." entry wins over a shorter "word" key.
        result = translateColoredSegments(normalized);
        if (result !== normalized) {
            normalized = result;
        }

        result = translateMessageBodyBeforeLines(normalized);
        if (result !== normalized) {
            return cacheFinalTranslation(text, result);
        }

        if (normalized.indexOf("\n") >= 0) {
            // MTool dictionaries can store a long translation that spans
            // several command-401 lines without including the final line of
            // the message. Match those cross-line entries before falling back
            // to per-line fragments; otherwise the long key is invisible and
            // short English words can produce a mixed-language sentence.
            result = translateLongestSubstrings(normalized);
            if (result !== normalized) {
                return cacheFinalTranslation(text, result);
            }

            lines = normalized.split("\n");
            for (index = 0; index < lines.length; index += 1) {
                translatedLine = translateLine(lines[index]);
                if (translatedLine !== lines[index]) {
                    lines[index] = translatedLine;
                    changed = true;
                }
            }
            if (changed) {
                result = lines.join("\n");
                return cacheFinalTranslation(text, result);
            }
        }

        result = translateLine(normalized);
        if (result !== normalized) {
            return cacheFinalTranslation(text, result);
        }

        return cacheFinalTranslation(text, normalized);
    }


    // Runtime strings that are identifiers/resources rather than visible text.
    // These must never be sent through the translation dictionary.
    function isProtectedRuntimeString(text) {
        var value = String(text || "");
        var lower = value.toLowerCase();
        if (!value) {
            return false;
        }

        // RPG Maker / WebView resource paths and URLs.
        if (/^(?:https?:|file:|blob:|data:)/i.test(value)) {
            return true;
        }
        if (/(?:^|[\/\\])(?:img|audio|movies|fonts|data|js|icon)(?:[\/\\]|$)/i.test(value)) {
            return true;
        }
        if (/\.(?:png|jpe?g|gif|webp|ogg|m4a|wav|mp3|flac|aac|webm|mp4|json|js|css|woff2?|ttf|otf|rpgm(?:vp|vm|vo|ve))$/i.test(value)) {
            return true;
        }
        if (/^(?:audio|img|movies|fonts|data|js)[\/\\]/i.test(lower)) {
            return true;
        }
        // Common plugin/resource identifiers.
        if (/^(?:plugins?|plugincommands?|commonEvents?|maps?|pictures?|backgrounds?|characters?|faces?|system|voices?)[\/:_-]/i.test(value)) {
            return true;
        }
        return false;
    }

    function translateDisplayTextSafely(text) {
        if (typeof text !== "string" || !text) {
            return text;
        }
        if (isProtectedRuntimeString(text)) {
            return text;
        }
        return translateText(text);
    }

    // MTool-style compatibility: keep convertEscapeCharacters active globally
    // for standard and custom Window_Base subclasses, but never translate
    // runtime/resource identifiers. This catches games whose dialogue window
    // bypasses our drawTextEx wrapper and calls convertEscapeCharacters directly.
    function installGlobalSafeConvertHook() {
        if (typeof Window_Base === "undefined" ||
                !Window_Base.prototype ||
                typeof Window_Base.prototype.convertEscapeCharacters !== "function") {
            return;
        }

        var current = Window_Base.prototype.convertEscapeCharacters;
        if (current[DISPLAY_WRAPPER_MARK] &&
                current[DISPLAY_WRAPPER_ORIGINAL]) {
            return;
        }

        var original = current;
        var wrapped = function(text) {
            var input = text;
            var converted;
            if (typeof input === "string" && !isProtectedRuntimeString(input)) {
                input = translateText(input);
            }
            converted = original.call(this, input);
            if (typeof converted === "string" &&
                    !isProtectedRuntimeString(converted)) {
                converted = translateText(converted);
            }
            return converted;
        };

        wrapped[DISPLAY_WRAPPER_MARK] = true;
        wrapped[DISPLAY_WRAPPER_ORIGINAL] = original;
        Window_Base.prototype.convertEscapeCharacters = wrapped;
    }

    function callInTextTranslationStage(target, callback, args) {
        var hadOwnConvert;
        var originalConvert;

        if (!target || typeof target.convertEscapeCharacters !== "function") {
            return callback.apply(target, args);
        }

        hadOwnConvert = hasOwn(target, "convertEscapeCharacters");
        originalConvert = target.convertEscapeCharacters;
        target.convertEscapeCharacters = function(text) {
            var convertedText;
            if (typeof text === "string") {
                arguments[0] = translateText(text);
            }
            convertedText = originalConvert.apply(this, arguments);
            // Actor names, variable contents and other display values appear
            // only after RPG Maker expands their escape codes. Translate that
            // expanded display text while the message/draw call is active.
            if (typeof convertedText === "string") {
                convertedText = translateText(convertedText);
            }
            return convertedText;
        };

        try {
            return callback.apply(target, args);
        } finally {
            if (hadOwnConvert) {
                target.convertEscapeCharacters = originalConvert;
            } else {
                delete target.convertEscapeCharacters;
            }
        }
    }

    function createDisplayMethodWrapper(originalMethod, translateEscapes) {
        var wrappedMethod = function() {
            if (typeof arguments[0] === "string") {
                arguments[0] = translateText(arguments[0]);
            }
            if (translateEscapes) {
                return callInTextTranslationStage(
                    this,
                    originalMethod,
                    arguments
                );
            }
            return originalMethod.apply(this, arguments);
        };

        wrappedMethod[DISPLAY_WRAPPER_MARK] = true;
        wrappedMethod[DISPLAY_WRAPPER_ORIGINAL] = originalMethod;
        return wrappedMethod;
    }

    function wrapOwnWindowDisplayMethod(prototype, methodConfig) {
        var descriptor;
        var originalMethod;
        var wrappedMethod;

        try {
            descriptor = Object.getOwnPropertyDescriptor(
                prototype,
                methodConfig.name
            );
        } catch (descriptorError) {
            return false;
        }

        if (!descriptor || typeof descriptor.value !== "function") {
            return false;
        }

        originalMethod = descriptor.value;
        if (originalMethod[DISPLAY_WRAPPER_MARK]) {
            return false;
        }
        if (descriptor.writable === false && descriptor.configurable === false) {
            return false;
        }

        wrappedMethod = createDisplayMethodWrapper(
            originalMethod,
            methodConfig.translateEscapes
        );
        descriptor.value = wrappedMethod;

        try {
            Object.defineProperty(prototype, methodConfig.name, descriptor);
            return true;
        } catch (defineError) {
            try {
                prototype[methodConfig.name] = wrappedMethod;
                return prototype[methodConfig.name] === wrappedMethod;
            } catch (assignmentError) {
                return false;
            }
        }
    }

    function inheritsFromWindowBase(prototype) {
        var basePrototype;
        var current;
        var depth = 0;

        if (typeof Window_Base === "undefined" ||
                !Window_Base.prototype || !prototype) {
            return false;
        }

        basePrototype = Window_Base.prototype;
        current = prototype;
        while (current && depth < 64) {
            if (current === basePrototype) {
                return true;
            }
            try {
                current = Object.getPrototypeOf(current);
            } catch (prototypeError) {
                return false;
            }
            depth += 1;
        }
        return false;
    }

    function wrapWindowPrototype(prototype) {
        var index;

        if (!inheritsFromWindowBase(prototype)) {
            return;
        }
        for (index = 0; index < WINDOW_DISPLAY_METHODS.length; index += 1) {
            wrapOwnWindowDisplayMethod(
                prototype,
                WINDOW_DISPLAY_METHODS[index]
            );
        }
    }

    function wrapWindowPrototypeChain(prototype) {
        var current = prototype;
        var depth = 0;

        while (current && depth < 64 && inheritsFromWindowBase(current)) {
            wrapWindowPrototype(current);
            if (current === Window_Base.prototype) {
                break;
            }
            try {
                current = Object.getPrototypeOf(current);
            } catch (prototypeError) {
                break;
            }
            depth += 1;
        }
    }

    function installWindowDisplayHooks() {
        var globalNames;
        var seenPrototypes = [];
        var index;

        if (typeof Window_Base === "undefined" || !Window_Base.prototype) {
            return;
        }

        function wrapOnce(prototype) {
            var seenIndex;
            if (!prototype) {
                return;
            }
            for (seenIndex = 0;
                    seenIndex < seenPrototypes.length;
                    seenIndex += 1) {
                if (seenPrototypes[seenIndex] === prototype) {
                    return;
                }
            }
            seenPrototypes.push(prototype);
            wrapWindowPrototypeChain(prototype);
        }

        wrapOnce(Window_Base.prototype);

        try {
            globalNames = Object.getOwnPropertyNames(window);
        } catch (namesError) {
            globalNames = [];
        }

        for (index = 0; index < globalNames.length; index += 1) {
            var globalDescriptor;
            var constructorCandidate;
            var candidatePrototype;

            try {
                globalDescriptor = Object.getOwnPropertyDescriptor(
                    window,
                    globalNames[index]
                );
            } catch (globalDescriptorError) {
                continue;
            }

            constructorCandidate = globalDescriptor && globalDescriptor.value;
            if (typeof constructorCandidate !== "function") {
                continue;
            }
            candidatePrototype = constructorCandidate.prototype;
            if (!candidatePrototype ||
                    !inheritsFromWindowBase(candidatePrototype)) {
                continue;
            }
            wrapOnce(candidatePrototype);
        }
    }

    function installWindowInstanceDiscoveryHooks() {
        var originalInitialize;
        var wrappedInitialize;
        var originalAddWindow;
        var wrappedAddWindow;

        if (typeof Window_Base !== "undefined" && Window_Base.prototype &&
                typeof Window_Base.prototype.initialize === "function" &&
                !Window_Base.prototype.initialize[INSTANCE_DISCOVERY_MARK]) {
            originalInitialize = Window_Base.prototype.initialize;
            wrappedInitialize = function() {
                try {
                    wrapWindowPrototypeChain(this);
                } catch (prototypeError) {
                    // The original initializer still runs if inspection fails.
                }
                return originalInitialize.apply(this, arguments);
            };
            wrappedInitialize[INSTANCE_DISCOVERY_MARK] = true;
            Window_Base.prototype.initialize = wrappedInitialize;
        }

        if (typeof Scene_Base !== "undefined" && Scene_Base.prototype &&
                typeof Scene_Base.prototype.addWindow === "function" &&
                !Scene_Base.prototype.addWindow[INSTANCE_DISCOVERY_MARK]) {
            originalAddWindow = Scene_Base.prototype.addWindow;
            wrappedAddWindow = function(windowInstance) {
                if (windowInstance) {
                    try {
                        wrapWindowPrototypeChain(windowInstance);
                    } catch (prototypeError) {
                        // Adding the window must never depend on hook discovery.
                    }
                }
                return originalAddWindow.apply(this, arguments);
            };
            wrappedAddWindow[INSTANCE_DISCOVERY_MARK] = true;
            Scene_Base.prototype.addWindow = wrappedAddWindow;
        }
    }

    // Translate the RPG Maker/NW.js browser window title.
    // MV/MZ normally sets document.title from $dataSystem.gameTitle in
    // Scene_Boot.updateDocumentTitle(), which is not a Window_* draw call.
    function translateDocumentTitle() {
        var title;
        var translatedTitle;
        if (state !== STATE_READY || typeof document === "undefined") {
            return;
        }
        try {
            title = document.title || "";
            if (title) {
                translatedTitle = translateText(title);
                if (translatedTitle !== title) {
                    document.title = translatedTitle;
                }
            }
            if (typeof $dataSystem !== "undefined" &&
                    $dataSystem && typeof $dataSystem.gameTitle === "string") {
                title = $dataSystem.gameTitle;
                translatedTitle = translateText(title);
                if (translatedTitle !== title) {
                    $dataSystem.gameTitle = translatedTitle;
                    if (typeof document !== "undefined") {
                        document.title = translatedTitle;
                    }
                }
            }
        } catch (titleError) {
            // Title translation must never interrupt boot.
        }
    }

    function installTitleHooks() {
        if (typeof Scene_Boot === "undefined" ||
                !Scene_Boot.prototype) {
            return;
        }
        if (typeof Scene_Boot.prototype.updateDocumentTitle === "function" &&
                !Scene_Boot.prototype.updateDocumentTitle[DISPLAY_WRAPPER_MARK]) {
            var originalUpdateDocumentTitle =
                Scene_Boot.prototype.updateDocumentTitle;
            var wrappedUpdateDocumentTitle = function() {
                var result = originalUpdateDocumentTitle.apply(this, arguments);
                translateDocumentTitle();
                return result;
            };
            wrappedUpdateDocumentTitle[DISPLAY_WRAPPER_MARK] = true;
            wrappedUpdateDocumentTitle[DISPLAY_WRAPPER_ORIGINAL] =
                originalUpdateDocumentTitle;
            Scene_Boot.prototype.updateDocumentTitle =
                wrappedUpdateDocumentTitle;
        }
        // Some custom projects set the title directly without using the
        // standard Scene_Boot method, so also retry after database readiness.
        translateDocumentTitle();
    }

    function installRuntimeHooks() {
        if (typeof DataManager !== "undefined" &&
                typeof DataManager.isDatabaseLoaded === "function") {
            var originalIsDatabaseLoaded = DataManager.isDatabaseLoaded;
            DataManager.isDatabaseLoaded = function() {
                var databaseReady = originalIsDatabaseLoaded.apply(
                    this,
                    arguments
                );
                if (!databaseReady) {
                    return databaseReady;
                }
                if (state !== STATE_LOADING) {
                    installGlobalSafeConvertHook();
                }
                if (state !== STATE_LOADING &&
                        !displayHooksRefreshedAfterLoad) {
                    installWindowDisplayHooks();
                    installTitleHooks();
                    displayHooksRefreshedAfterLoad = true;
                }
                if (state !== STATE_LOADING) {
                    translateDocumentTitle();
                }
                return state !== STATE_LOADING;
            };
        }

        // MTool's primary MV/MZ display hook runs after all command-401 lines
        // have entered $gameMessage, so the dictionary can match the complete
        // message (including embedded newlines) before rendering begins.
        if (typeof Window_Message !== "undefined" &&
                Window_Message.prototype &&
                typeof Window_Message.prototype.startMessage === "function") {
            var originalWindowMessageStart =
                Window_Message.prototype.startMessage;
            Window_Message.prototype.startMessage = function() {
                var gameMessage = typeof $gameMessage !== "undefined" ?
                    $gameMessage : null;
                var sourceLines;
                var sourceText;
                var translatedText;

                if (state === STATE_READY && gameMessage &&
                        Array.isArray(gameMessage._texts) &&
                        gameMessage._texts.length > 0) {
                    sourceLines = gameMessage._texts;
                    sourceText = sourceLines.join("\n");
                    translatedText = translateText(sourceText);
                    if (translatedText !== sourceText) {
                        gameMessage._texts = translatedText.split("\n");
                    }
                }
                return callInTextTranslationStage(
                    this,
                    originalWindowMessageStart,
                    arguments
                );
            };
        }

        installGlobalSafeConvertHook();
        installWindowDisplayHooks();
        installWindowInstanceDiscoveryHooks();
        installTitleHooks();

        if (typeof Bitmap !== "undefined" && Bitmap.prototype) {
            if (typeof Bitmap.prototype.drawText === "function") {
                var originalBitmapDrawText = Bitmap.prototype.drawText;
                Bitmap.prototype.drawText = function(text) {
                    // MV's processNormalCharacter calls Bitmap.drawText once
                    // per glyph. Respect the fragment threshold at this
                    // low-level hook so entries such as "I" never corrupt an
                    // otherwise intact sentence. Standard short UI text is
                    // already handled by the higher-level Window_Base hook.
                    if (typeof text === "string" &&
                            text.length >= minSubstringLength) {
                        arguments[0] = translateText(text);
                    }
                    return originalBitmapDrawText.apply(this, arguments);
                };
            }

            if (typeof Bitmap.prototype.measureTextWidth === "function") {
                var originalBitmapMeasureTextWidth =
                    Bitmap.prototype.measureTextWidth;
                Bitmap.prototype.measureTextWidth = function(text) {
                    // Keep direct plugin measurements consistent with the text
                    // that Bitmap.drawText will render, while retaining the
                    // same per-glyph short-key guard.
                    if (typeof text === "string" &&
                            text.length >= minSubstringLength) {
                        arguments[0] = translateText(text);
                    }
                    return originalBitmapMeasureTextWidth.apply(
                        this,
                        arguments
                    );
                };
            }
        }
    }
})();
