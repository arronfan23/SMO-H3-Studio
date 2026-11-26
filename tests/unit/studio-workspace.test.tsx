import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, test } from 'vitest';
import { StudioWorkspace } from '../../src/renderer/StudioWorkspace';

describe('StudioWorkspace', () => {
  test('places the editor before output in the labelled complementary pane', () => {
    render(
      <StudioWorkspace
        editor={<p>编辑器内容</p>}
        output={<p>结果内容</p>}
      />,
    );

    const editor = screen.getByText('编辑器内容');
    const editorPane = editor.closest('.studio-editor-pane');
    const outputPane = screen.getByRole('complementary', { name: '任务与结果' });

    expect(editorPane).not.toBeNull();
    expect(editorPane).toContainElement(editor);
    expect(outputPane).toContainElement(screen.getByText('结果内容'));
    expect(editorPane?.nextElementSibling).toBe(outputPane);
  });
});
