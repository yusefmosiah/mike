package com.firm.mike.speech;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Fluid Speech Mini's tokens back to text, as the reference script decodes
 * them: pieces joined, the word marker turned into a space, the leading space
 * dropped; blank, padding and special tokens left out.
 */
final class Tokenizer {
    private final Map<Integer, String> pieces = new HashMap<>();
    private final Set<Integer> skip = new HashSet<>();
    private final String space;

    Tokenizer(String json, int blankId, int padId) throws JSONException {
        JSONObject root = new JSONObject(json);
        JSONObject model = root.getJSONObject("model");
        Object vocab = model.get("vocab");
        if (vocab instanceof JSONObject entries) {
            Iterator<String> keys = entries.keys();
            while (keys.hasNext()) {
                String piece = keys.next();
                pieces.put(entries.getInt(piece), piece);
            }
        } else if (vocab instanceof JSONArray list) {
            for (int id = 0; id < list.length(); id++) pieces.put(id, list.getJSONArray(id).getString(0));
        }
        skip.add(blankId);
        skip.add(padId);
        JSONArray added = root.optJSONArray("added_tokens");
        if (added != null) {
            for (int i = 0; i < added.length(); i++) {
                JSONObject token = added.getJSONObject(i);
                pieces.put(token.getInt("id"), token.getString("content"));
                if (token.optBoolean("special")) skip.add(token.getInt("id"));
            }
        }
        JSONObject decoder = root.optJSONObject("decoder");
        space = decoder != null ? decoder.optString("replacement", "▁") : "▁";
    }

    String piece(int id) {
        return pieces.getOrDefault(id, "");
    }

    /** Whether the token starts a word (its piece begins with the word marker). */
    boolean startsWord(int id) {
        return piece(id).startsWith(space);
    }

    boolean isSkipped(int id) {
        return skip.contains(id);
    }

    String decode(List<Integer> ids) {
        StringBuilder text = new StringBuilder();
        for (int id : ids) {
            if (!skip.contains(id)) text.append(piece(id));
        }
        String joined = text.toString().replace(space, " ");
        return joined.startsWith(" ") ? joined.substring(1) : joined;
    }
}
