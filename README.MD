PNG_Utils is a PNG decoder and collection of useful functions to read, parse, and edit PNG files in pure JS without the need for Node.
====

Usage
----
``` 
    //With event
    function foo(evt) {
    const myPNG = await new png(evt);
    }
    //Without event
    function foo(file) {
        const myPNG = await new png(file);
    }

```
Decompression, unfiltering, and extracting sub-images.
----
    function foo(evt) {
        const myPNG = await new png(evt);
        const decompressedData = await myPNG.decompressIDATData();
        const unfilteredData = myPNG.reverseFiltering(decompressedData);
        const subImage = myPNG.subImage(unfilteredData);
    }
