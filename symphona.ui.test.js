const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("symphona ships without playlist export controls", () => {
    const source = fs.readFileSync(path.join(__dirname, "symphona.js"), "utf8");

    assert.equal(source.includes("Create Shared Playlist"), false);
    assert.equal(source.includes("Create First Only Playlist"), false);
    assert.equal(source.includes("Create Second Only Playlist"), false);
    assert.equal(source.includes("createPlaylistFromTracks"), false);
});
