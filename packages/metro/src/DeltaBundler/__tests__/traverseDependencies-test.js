/**
 * Copyright (c) 2015-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+javascript_foundation
 * @format
 */

'use strict';

const {
  initialTraverseDependencies,
  reorderGraph,
  traverseDependencies,
} = require('../traverseDependencies');

let dependencyGraph;
let mockedDependencies;
let mockedDependencyTree;
let files = new Set();
let graph;
let options;

let entryModule;
let moduleFoo;
let moduleBar;
let moduleBaz;

const Actions = {
  modifyFile(path) {
    if (mockedDependencies.has(path)) {
      files.add(path);
    }
  },

  moveFile(from, to) {
    Actions.createFile(to);
    Actions.deleteFile(from);
  },

  deleteFile(path) {
    mockedDependencies.delete(path);
  },

  createFile(path) {
    mockedDependencies.add(path);
    mockedDependencyTree.set(path, []);

    return path;
  },

  addDependency(path, dependencyPath, position, name = null) {
    const deps = mockedDependencyTree.get(path);
    name = name || dependencyPath.replace('/', '');

    if (position == null) {
      deps.push({name, path: dependencyPath});
    } else {
      deps.splice(position, 0, {name, path: dependencyPath});
    }

    mockedDependencyTree.set(path, deps);
    mockedDependencies.add(dependencyPath);

    files.add(path);
  },

  removeDependency(path, dependencyPath) {
    const deps = mockedDependencyTree.get(path);

    const index = deps.findIndex(({path}) => path === dependencyPath);
    if (index !== -1) {
      deps.splice(index, 1);
      mockedDependencyTree.set(path, deps);
    }

    files.add(path);
  },
};

function deferred(value) {
  let resolve;
  const promise = new Promise(res => (resolve = res));

  return {promise, resolve: () => resolve(value)};
}

function getPaths({added, deleted}) {
  const addedPaths = [...added.values()].map(module => module.path);

  return {
    added: new Set(addedPaths),
    deleted,
  };
}

beforeEach(async () => {
  mockedDependencies = new Set();
  mockedDependencyTree = new Map();

  dependencyGraph = {
    getAbsolutePath(path) {
      return '/' + path;
    },
    getModuleForPath(path) {
      return Array.from(mockedDependencies).find(dep => dep.path === path);
    },
    resolveDependency(module, relativePath) {
      const deps = mockedDependencyTree.get(module.path);
      const {dependency} = deps.filter(dep => dep.name === relativePath)[0];

      if (!mockedDependencies.has(dependency)) {
        throw new Error(
          `Dependency not found: ${module.path}->${relativePath}`,
        );
      }
      return dependency;
    },
  };

  options = {
    resolve: (from, to) => {
      const deps = mockedDependencyTree.get(from);
      const {path} = deps.filter(dep => dep.name === to)[0];

      if (!mockedDependencies.has(path)) {
        throw new Error(`Dependency not found: ${path}->${to}`);
      }
      return path;
    },
    transform: path => {
      return {
        dependencies: (mockedDependencyTree.get(path) || []).map(dep => ({
          name: dep.name,
          isAsync: false,
        })),
        getSource: () => '// source',
        output: [
          {
            data: {
              code: '// code',
              map: [],
            },
            type: 'js/module',
          },
        ],
      };
    },
    onProgress: null,
  };

  // Generate the initial dependency graph.
  entryModule = Actions.createFile('/bundle');
  moduleFoo = Actions.createFile('/foo');
  moduleBar = Actions.createFile('/bar');
  moduleBaz = Actions.createFile('/baz');

  Actions.addDependency('/bundle', '/foo');
  Actions.addDependency('/foo', '/bar');
  Actions.addDependency('/foo', '/baz');

  files = new Set();

  graph = {
    dependencies: new Map(),
    entryPoints: ['/bundle'],
  };
});

it('should do the initial traversal correctly', async () => {
  const result = await initialTraverseDependencies(graph, options);

  expect(getPaths(result)).toEqual({
    added: new Set(['/bundle', '/foo', '/bar', '/baz']),
    deleted: new Set(),
  });

  expect(graph).toMatchSnapshot();
});

it('should populate all the inverse dependencies', async () => {
  // create a second inverse dependency on /bar.
  Actions.addDependency('/bundle', '/bar');

  await initialTraverseDependencies(graph, options);

  expect(graph.dependencies.get('/bar').inverseDependencies).toEqual(
    new Set(['/foo', '/bundle']),
  );
});

it('should return an empty result when there are no changes', async () => {
  await initialTraverseDependencies(graph, options);

  expect(
    getPaths(await traverseDependencies(['/bundle'], graph, options)),
  ).toEqual({
    added: new Set(['/bundle']),
    deleted: new Set(),
  });
});

it('should return a removed dependency', async () => {
  await initialTraverseDependencies(graph, options);

  Actions.removeDependency('/foo', '/bar');

  expect(
    getPaths(await traverseDependencies([...files], graph, options)),
  ).toEqual({
    added: new Set(['/foo']),
    deleted: new Set(['/bar']),
  });
});

it('should return added/removed dependencies', async () => {
  await initialTraverseDependencies(graph, options);

  Actions.addDependency('/foo', '/qux');
  Actions.removeDependency('/foo', '/bar');
  Actions.removeDependency('/foo', '/baz');

  expect(
    getPaths(await traverseDependencies([...files], graph, options)),
  ).toEqual({
    added: new Set(['/foo', '/qux']),
    deleted: new Set(['/bar', '/baz']),
  });
});

it('should return added modules before the modified ones', async () => {
  await initialTraverseDependencies(graph, options);

  Actions.addDependency('/foo', '/qux');
  Actions.modifyFile('/bar');
  Actions.modifyFile('/baz');

  // extect.toEqual() does not check order of Sets/Maps, so we need to convert
  // it to an array.
  expect([
    ...getPaths(await traverseDependencies([...files], graph, options)).added,
  ]).toEqual(['/qux', '/foo', '/bar', '/baz']);
});

it('should retry to traverse the dependencies as it was after getting an error', async () => {
  await initialTraverseDependencies(graph, options);

  Actions.deleteFile(moduleBar);

  await expect(
    traverseDependencies(['/foo'], graph, options),
  ).rejects.toBeInstanceOf(Error);

  // Second time that the traversal of dependencies we still have to throw an
  // error (no matter if no file has been changed).
  await expect(
    traverseDependencies(['/foo'], graph, options),
  ).rejects.toBeInstanceOf(Error);
});

describe('Progress updates', () => {
  it('calls back for each finished module', async () => {
    const onProgress = jest.fn();

    await initialTraverseDependencies(graph, {...options, onProgress});

    // We get a progress change twice per dependency
    // (when we discover it and when we process it).
    expect(onProgress.mock.calls.length).toBe(mockedDependencies.size * 2);
  });

  it('increases the number of discover/finished modules in steps of one', async () => {
    const onProgress = jest.fn();

    await initialTraverseDependencies(graph, {...options, onProgress});

    const lastCall = {
      num: 0,
      total: 0,
    };
    for (const call of onProgress.mock.calls) {
      expect(call[0]).toBeGreaterThanOrEqual(lastCall.num);
      expect(call[1]).toBeGreaterThanOrEqual(lastCall.total);

      expect(call[0] + call[1]).toEqual(lastCall.num + lastCall.total + 1);
      lastCall.num = call[0];
      lastCall.total = call[1];
    }
  });
});

describe('edge cases', () => {
  it('should handle cyclic dependencies', async () => {
    Actions.addDependency('/baz', '/foo');
    files = new Set();

    expect(getPaths(await initialTraverseDependencies(graph, options))).toEqual(
      {
        added: new Set(['/bundle', '/foo', '/bar', '/baz']),
        deleted: new Set(),
      },
    );

    expect(graph.dependencies.get('/foo').inverseDependencies).toEqual(
      new Set(['/bundle', '/baz']),
    );
  });

  it('should handle renames correctly', async () => {
    await initialTraverseDependencies(graph, options);

    Actions.removeDependency('/foo', '/baz');
    Actions.moveFile('/baz', '/qux');
    Actions.addDependency('/foo', '/qux');

    expect(
      getPaths(await traverseDependencies([...files], graph, options)),
    ).toEqual({
      added: new Set(['/foo', '/qux']),
      deleted: new Set(['/baz']),
    });
  });

  it('should not try to remove wrong dependencies when renaming files', async () => {
    await initialTraverseDependencies(graph, options);

    // Rename /foo to /foo-renamed, but keeping all its dependencies.
    Actions.addDependency('/bundle', '/foo-renamed');
    Actions.removeDependency('/bundle', '/foo');

    Actions.moveFile('/foo', '/foo-renamed');
    Actions.addDependency('/foo-renamed', '/bar');
    Actions.addDependency('/foo-renamed', '/baz');

    expect(
      getPaths(await traverseDependencies([...files], graph, options)),
    ).toEqual({
      added: new Set(['/bundle', '/foo-renamed']),
      deleted: new Set(['/foo']),
    });

    expect(graph.dependencies.get('/foo')).toBe(undefined);
  });

  it('modify a file and delete it afterwards', async () => {
    await initialTraverseDependencies(graph, options);

    Actions.modifyFile('/baz');
    Actions.removeDependency('/foo', '/baz');

    expect(
      getPaths(await traverseDependencies([...files], graph, options)),
    ).toEqual({
      added: new Set(['/foo']),
      deleted: new Set(['/baz']),
    });

    expect(graph.dependencies.get('/baz')).toBe(undefined);
  });

  it('remove a dependency and modify it afterwards', async () => {
    await initialTraverseDependencies(graph, options);

    Actions.removeDependency('/bundle', '/foo');
    Actions.modifyFile('/foo');

    expect(
      getPaths(await traverseDependencies([...files], graph, options)),
    ).toEqual({
      added: new Set(['/bundle']),
      deleted: new Set(['/foo', '/bar', '/baz']),
    });

    expect(graph.dependencies.get('/foo')).toBe(undefined);
    expect(graph.dependencies.get('/bar')).toBe(undefined);
    expect(graph.dependencies.get('/baz')).toBe(undefined);
  });

  it('removes a cyclic dependency', async () => {
    Actions.addDependency('/baz', '/foo');
    files = new Set();

    await initialTraverseDependencies(graph, options);

    Actions.removeDependency('/bundle', '/foo');

    // Unfortunately, since we do reference counting we cannot detect that the
    // whole cycle has been removed from the graph.
    expect(
      getPaths(await traverseDependencies([...files], graph, options)),
    ).toEqual({
      added: new Set(['/bundle']),
      deleted: new Set([]),
    });

    // Now break the cycle. Once we break the cycle, we can detect that no
    // module is being used and remove all of them.
    files = new Set();
    Actions.removeDependency('/baz', '/foo');

    expect(
      getPaths(await traverseDependencies([...files], graph, options)),
    ).toEqual({
      added: new Set([]),
      deleted: new Set(['/foo', '/bar', '/baz']),
    });
  });

  it('move a file to a different folder', async () => {
    await initialTraverseDependencies(graph, options);

    Actions.addDependency('/foo', '/baz-moved');
    Actions.removeDependency('/foo', '/baz');

    expect(
      getPaths(await traverseDependencies([...files], graph, options)),
    ).toEqual({
      added: new Set(['/foo', '/baz-moved']),
      deleted: new Set(['/baz']),
    });

    expect(graph.dependencies.get('/baz')).toBe(undefined);
  });

  it('maintain the order of module dependencies consistent', async () => {
    await initialTraverseDependencies(graph, options);

    Actions.addDependency('/foo', '/qux', 0);

    expect(
      getPaths(await traverseDependencies([...files], graph, options)),
    ).toEqual({
      added: new Set(['/foo', '/qux']),
      deleted: new Set(),
    });

    expect([...graph.dependencies.get(moduleFoo).dependencies]).toEqual([
      ['qux', {absolutePath: '/qux', data: {isAsync: false, name: 'qux'}}],
      ['bar', {absolutePath: '/bar', data: {isAsync: false, name: 'bar'}}],
      ['baz', {absolutePath: '/baz', data: {isAsync: false, name: 'baz'}}],
    ]);
  });

  it('should create two entries when requiring the same file in different forms', async () => {
    await initialTraverseDependencies(graph, options);

    // We're adding a new reference from bundle to foo.
    Actions.addDependency('/bundle', '/foo', 0, 'foo.js');

    expect(
      getPaths(await traverseDependencies([...files], graph, options)),
    ).toEqual({
      added: new Set(['/bundle']),
      deleted: new Set(),
    });

    expect([...graph.dependencies.get(entryModule).dependencies]).toEqual([
      [
        'foo.js',
        {
          absolutePath: '/foo',
          data: {
            isAsync: false,
            name: 'foo.js',
          },
        },
      ],
      [
        'foo',
        {
          absolutePath: '/foo',
          data: {
            isAsync: false,
            name: 'foo',
          },
        },
      ],
    ]);
  });

  it('should traverse a graph from multiple entry points', async () => {
    entryModule = Actions.createFile('/bundle-2');

    Actions.addDependency('/bundle-2', '/bundle-2-foo');
    Actions.addDependency('/bundle-2', '/bundle-2-bar');
    Actions.addDependency('/bundle-2', '/bar');

    files = new Set();

    graph = {
      dependencies: new Map(),
      entryPoints: ['/bundle', '/bundle-2'],
    };

    await initialTraverseDependencies(graph, options);

    expect([...graph.dependencies.keys()]).toEqual([
      '/bundle',
      '/foo',
      '/bar',
      '/baz',
      '/bundle-2',
      '/bundle-2-foo',
      '/bundle-2-bar',
    ]);
  });

  it('should traverse the dependency tree in a deterministic order', async () => {
    // Mocks the shallow dependency call, always resolving the module in
    // `slowPath` after the module in `fastPath`.
    function mockShallowDependencies(slowPath, fastPath) {
      let deferredSlow;
      let fastResolved = false;

      dependencyGraph.getShallowDependencies = async path => {
        const deps = mockedDependencyTree.get(path);

        const result = deps
          ? await Promise.all(deps.map(dep => dep.getName()))
          : [];

        if (path === slowPath && !fastResolved) {
          // Return a Promise that won't be resolved after fastPath.
          deferredSlow = deferred(result);
          return deferredSlow.promise;
        }

        if (path === fastPath) {
          fastResolved = true;

          if (deferredSlow) {
            return new Promise(async resolve => {
              await resolve(result);

              deferredSlow.resolve();
            });
          }
        }

        return result;
      };
    }

    const assertOrder = async function() {
      graph = {
        dependencies: new Map(),
        entryPoints: ['/bundle'],
      };

      expect(
        Array.from(
          getPaths(await initialTraverseDependencies(graph, options)).added,
        ),
      ).toEqual(['/bundle', '/foo', '/baz', '/bar']);
    };

    // Create a dependency tree where moduleBaz has two inverse dependencies.
    mockedDependencyTree = new Map([
      [
        entryModule,
        [{name: 'foo', path: moduleFoo}, {name: 'bar', path: moduleBar}],
      ],
      [moduleFoo, [{name: 'baz', path: moduleBaz}]],
      [moduleBar, [{name: 'baz', path: moduleBaz}]],
    ]);

    // Test that even when having different modules taking longer, the order
    // remains the same.
    mockShallowDependencies('/foo', '/bar');
    await assertOrder();

    mockShallowDependencies('/bar', '/foo');
    await assertOrder();
  });
});

describe('reorderGraph', () => {
  it('should reorder any unordered graph in DFS order', async () => {
    const dep = path => ({
      absolutePath: path,
      data: {isAsync: false, name: path.substr(1)},
    });

    // prettier-ignore
    const graph = {
      dependencies: new Map([
        ['/2', {path: '/2', dependencies: new Map()}],
        ['/0', {path: '/0', dependencies: new Map([['/1', dep('/1')], ['/2', dep('/2')]])}],
        ['/1', {path: '/1', dependencies: new Map([['/2', dep('/2')]])}],
        ['/3', {path: '/3', dependencies: new Map([])}],
        ['/b', {path: '/b', dependencies: new Map([['/3', dep('/3')]])}],
        ['/a', {path: '/a', dependencies: new Map([['/0', dep('/0')]])}],
      ]),
      entryPoints: ['/a', '/b'],
    };

    reorderGraph(graph);

    expect([...graph.dependencies.keys()]).toEqual([
      '/a',
      '/0',
      '/1',
      '/2',
      '/b',
      '/3',
    ]);
  });
});
