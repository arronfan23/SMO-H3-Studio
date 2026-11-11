import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SmoApi } from '../../src/shared/ipc';
import { ReferenceImagePicker } from '../../src/renderer/ReferenceImagePicker';

const files = {
  selectImage: vi.fn(),
  authorizeDroppedImage: vi.fn(),
  mediaUrl: vi.fn(),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function PickerHarness({
  initialPaths,
  max,
  disabled = false,
  onChange,
}: {
  initialPaths: readonly string[];
  max: number;
  disabled?: boolean;
  onChange: (paths: string[]) => void;
}) {
  const [paths, setPaths] = useState(initialPaths);
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <ReferenceImagePicker
        paths={paths}
        max={max}
        disabled={disabled}
        onChange={(next) => {
          onChange(next);
          setPaths(next);
        }}
        onError={setError}
      />
      {error && <p role="alert">{error}</p>}
    </>
  );
}

function renderPicker({
  initialPaths = [],
  max = 4,
  disabled = false,
}: {
  initialPaths?: readonly string[];
  max?: number;
  disabled?: boolean;
} = {}) {
  const changes: string[][] = [];
  const view = render(
    <PickerHarness
      initialPaths={initialPaths}
      max={max}
      disabled={disabled}
      onChange={(next) => changes.push(next)}
    />,
  );
  return { changes, ...view };
}

function dropzone(): HTMLElement {
  return screen.getByRole('group', { name: '参考图拖放区' });
}

function imageFile(name: string): File {
  return new File(['image'], name, { type: 'image/png' });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.smo = { files } as unknown as SmoApi;
  files.selectImage.mockResolvedValue(null);
  files.authorizeDroppedImage.mockImplementation(
    async (file: { name: string }) => `G:\\dropped\\${file.name}`,
  );
  files.mediaUrl.mockImplementation(
    async (path: string) => `smo-media://media/${encodeURIComponent(path)}`,
  );
});

afterEach(() => {
  cleanup();
});

describe('ReferenceImagePicker', () => {
  test('adds dialog selections one at a time up to a configurable max of 4', async () => {
    let selection = 0;
    files.selectImage.mockImplementation(async () => {
      selection += 1;
      return `G:\\refs\\selected-${selection}.png`;
    });
    const { changes } = renderPicker({ max: 4 });

    for (let index = 1; index <= 4; index += 1) {
      fireEvent.click(screen.getByRole('button', { name: '选择参考图' }));
      expect(await screen.findByText(`selected-${index}.png`)).toBeInTheDocument();
      expect(changes.at(-1)).toEqual(
        Array.from({ length: index }, (_, item) => `G:\\refs\\selected-${item + 1}.png`),
      );
    }

    expect(changes).toHaveLength(4);
    expect(screen.getByRole('button', { name: '选择参考图' })).toBeDisabled();
    expect(files.selectImage).toHaveBeenCalledTimes(4);
  });

  test('authorizes a multi-image drop and preserves drop order when authorization finishes out of order', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const third = deferred<string>();
    files.authorizeDroppedImage
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const { changes } = renderPicker({ initialPaths: ['G:\\refs\\existing.png'], max: 9 });

    fireEvent.drop(dropzone(), {
      dataTransfer: { files: [imageFile('first.png'), imageFile('second.png'), imageFile('third.png')] },
    });
    expect(files.authorizeDroppedImage).toHaveBeenCalledTimes(3);
    expect(dropzone()).toHaveAttribute('aria-busy', 'true');

    await act(async () => {
      third.resolve('G:\\authorized\\third.png');
      second.resolve('G:\\authorized\\second.png');
      first.resolve('G:\\authorized\\first.png');
      await Promise.all([first.promise, second.promise, third.promise]);
    });

    expect(changes).toEqual([[
      'G:\\refs\\existing.png',
      'G:\\authorized\\first.png',
      'G:\\authorized\\second.png',
      'G:\\authorized\\third.png',
    ]]);
    expect(dropzone()).toHaveAttribute('aria-busy', 'false');
    const items = within(screen.getByRole('list', { name: '已选参考图' })).getAllByRole('listitem');
    ['existing.png', 'first.png', 'second.png', 'third.png'].forEach((name, index) => {
      expect(within(items[index]).getByText(String(index + 1))).toBeInTheDocument();
      expect(within(items[index]).getByText(name)).toBeInTheDocument();
    });
  });

  test.each([4, 9])('allows a drop with an existing-path alias when deduplicated additions exactly reach the max of %i', async (max) => {
    const initialPaths = Array.from({ length: max - 1 }, (_, index) =>
      index === 0 ? 'G:\\refs\\alpha.png' : `G:\\refs\\${index}.png`,
    );
    files.authorizeDroppedImage.mockImplementation(async (file: { name: string }) =>
      file.name === 'alpha-alias.png' ? 'G:\\refs\\alpha.png' : 'G:\\dropped\\new.png',
    );
    const { changes } = renderPicker({ initialPaths, max });

    fireEvent.drop(dropzone(), {
      dataTransfer: { files: [imageFile('alpha-alias.png'), imageFile('new.png')] },
    });

    expect(await screen.findByText('new.png')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('重复');
    expect(files.authorizeDroppedImage).toHaveBeenCalledTimes(2);
    expect(changes).toEqual([[...initialPaths, 'G:\\dropped\\new.png']]);
    expect(screen.getAllByRole('listitem')).toHaveLength(max);
    expect(screen.getAllByText('alpha.png')).toHaveLength(1);
  });

  test.each([4, 9])('authorizes first but rejects deduplicated additions that still exceed the max of %i', async (max) => {
    const initialPaths = Array.from({ length: max - 1 }, (_, index) => `G:\\refs\\${index}.png`);
    const { changes } = renderPicker({ initialPaths, max });

    fireEvent.drop(dropzone(), {
      dataTransfer: { files: [imageFile('one.png'), imageFile('two.png')] },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(`最多 ${max} 张`);
    expect(files.authorizeDroppedImage).toHaveBeenCalledTimes(2);
    expect(changes).toEqual([]);
    expect(screen.getAllByRole('listitem')).toHaveLength(max - 1);
  });

  test('uses useMediaUrl-backed previews with sequence numbers, filenames, and labeled icon buttons', async () => {
    renderPicker({ initialPaths: ['G:\\refs\\alpha.png', 'G:\\refs\\beta.jpg'], max: 4 });

    const first = await screen.findByAltText('参考图 1：alpha.png');
    const second = await screen.findByAltText('参考图 2：beta.jpg');
    expect(first).toHaveAttribute(
      'src',
      `smo-media://media/${encodeURIComponent('G:\\refs\\alpha.png')}`,
    );
    expect(second).toHaveAttribute(
      'src',
      `smo-media://media/${encodeURIComponent('G:\\refs\\beta.jpg')}`,
    );
    expect(files.mediaUrl).toHaveBeenCalledWith('G:\\refs\\alpha.png');
    expect(files.mediaUrl).toHaveBeenCalledWith('G:\\refs\\beta.jpg');
    expect(screen.getByText('alpha.png')).toHaveAttribute('title', 'G:\\refs\\alpha.png');
    expect(screen.getByText('beta.jpg')).toHaveAttribute('title', 'G:\\refs\\beta.jpg');

    const remove = screen.getByRole('button', { name: '删除参考图 1' });
    expect(remove).toHaveClass('button-icon');
    expect(remove.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  test('deletes one image without reordering the survivors and renumbers the list', async () => {
    const { changes } = renderPicker({
      initialPaths: ['G:\\refs\\alpha.png', 'G:\\refs\\beta.png', 'G:\\refs\\gamma.png'],
      max: 4,
    });
    await screen.findByAltText('参考图 1：alpha.png');

    fireEvent.click(screen.getByRole('button', { name: '删除参考图 2' }));

    expect(changes).toEqual([['G:\\refs\\alpha.png', 'G:\\refs\\gamma.png']]);
    const items = within(screen.getByRole('list', { name: '已选参考图' })).getAllByRole('listitem');
    expect(within(items[0]).getByText('1')).toBeInTheDocument();
    expect(within(items[0]).getByText('alpha.png')).toBeInTheDocument();
    expect(within(items[1]).getByText('2')).toBeInTheDocument();
    expect(within(items[1]).getByText('gamma.png')).toBeInTheDocument();
    expect(screen.queryByText('beta.png')).not.toBeInTheDocument();
  });

  test('rejects a duplicate dialog path and explains why nothing was added', async () => {
    files.selectImage.mockResolvedValue('G:\\refs\\alpha.png');
    const { changes } = renderPicker({ initialPaths: ['G:\\refs\\alpha.png'], max: 4 });

    fireEvent.click(screen.getByRole('button', { name: '选择参考图' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('重复');
    expect(changes).toEqual([]);
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  test('filters duplicate authorized paths from a drop without adding them twice', async () => {
    files.authorizeDroppedImage.mockImplementation(async (file: { name: string }) => {
      if (file.name === 'duplicate.png') return 'G:\\refs\\alpha.png';
      if (file.name === 'same-a.png' || file.name === 'same-b.png') return 'G:\\refs\\same.png';
      return 'G:\\refs\\new.png';
    });
    const { changes } = renderPicker({ initialPaths: ['G:\\refs\\alpha.png'], max: 9 });

    fireEvent.drop(dropzone(), {
      dataTransfer: {
        files: [imageFile('duplicate.png'), imageFile('same-a.png'), imageFile('same-b.png'), imageFile('new.png')],
      },
    });

    expect(await screen.findByText('new.png')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('重复');
    expect(changes).toEqual([[
      'G:\\refs\\alpha.png',
      'G:\\refs\\same.png',
      'G:\\refs\\new.png',
    ]]);
    expect(screen.getAllByText('alpha.png')).toHaveLength(1);
    expect(screen.getAllByText('same.png')).toHaveLength(1);
  });

  test('disabled prevents dialog selection, drops, highlighting, and deletion', async () => {
    const { changes } = renderPicker({ initialPaths: ['G:\\refs\\alpha.png'], max: 4, disabled: true });
    await screen.findByAltText('参考图 1：alpha.png');

    expect(screen.getByRole('button', { name: '选择参考图' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '删除参考图 1' })).toBeDisabled();
    expect(dropzone()).toHaveAttribute('aria-disabled', 'true');
    fireEvent.dragOver(dropzone(), { dataTransfer: { files: [] } });
    expect(dropzone()).not.toHaveAttribute('data-drop-active');
    fireEvent.drop(dropzone(), { dataTransfer: { files: [imageFile('blocked.png')] } });
    fireEvent.click(screen.getByRole('button', { name: '删除参考图 1' }));

    expect(files.selectImage).not.toHaveBeenCalled();
    expect(files.authorizeDroppedImage).not.toHaveBeenCalled();
    expect(changes).toEqual([]);
    expect(screen.getByText('alpha.png')).toBeInTheDocument();
  });

  test('a slow drop authorization cannot overwrite a newer drop', async () => {
    const slow = deferred<string>();
    files.authorizeDroppedImage
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce('G:\\dropped\\new.png');
    const { changes } = renderPicker({ max: 4 });

    fireEvent.drop(dropzone(), { dataTransfer: { files: [imageFile('slow.png')] } });
    fireEvent.drop(dropzone(), { dataTransfer: { files: [imageFile('new.png')] } });
    expect(await screen.findByText('new.png')).toBeInTheDocument();

    await act(async () => {
      slow.resolve('G:\\dropped\\slow.png');
      await slow.promise;
    });

    expect(changes).toEqual([['G:\\dropped\\new.png']]);
    expect(screen.queryByText('slow.png')).not.toBeInTheDocument();
    expect(screen.getByText('new.png')).toBeInTheDocument();
    expect(dropzone()).toHaveAttribute('aria-busy', 'false');
  });

  test('a slow drop authorization cannot undo a newer deletion', async () => {
    const slow = deferred<string>();
    files.authorizeDroppedImage.mockReturnValueOnce(slow.promise);
    const { changes } = renderPicker({ initialPaths: ['G:\\refs\\alpha.png'], max: 4 });
    await screen.findByAltText('参考图 1：alpha.png');

    fireEvent.drop(dropzone(), { dataTransfer: { files: [imageFile('slow.png')] } });
    fireEvent.click(screen.getByRole('button', { name: '删除参考图 1' }));
    expect(screen.queryByText('alpha.png')).not.toBeInTheDocument();

    await act(async () => {
      slow.resolve('G:\\dropped\\slow.png');
      await slow.promise;
    });

    expect(changes).toEqual([[]]);
    expect(screen.queryByText('slow.png')).not.toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(dropzone()).toHaveAttribute('aria-busy', 'false');
  });

  test('surfaces authorization failures and releases the pending state', async () => {
    files.authorizeDroppedImage.mockRejectedValue(new Error('授权失败'));
    const { changes } = renderPicker({ max: 4 });

    fireEvent.drop(dropzone(), { dataTransfer: { files: [imageFile('denied.png')] } });

    expect(await screen.findByRole('alert')).toHaveTextContent('授权失败');
    expect(dropzone()).toHaveAttribute('aria-busy', 'false');
    expect(screen.getByRole('button', { name: '选择参考图' })).toBeEnabled();
    expect(changes).toEqual([]);
  });
});
