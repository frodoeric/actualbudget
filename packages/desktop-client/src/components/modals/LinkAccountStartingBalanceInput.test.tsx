import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TestProviders } from '#mocks';

import { LinkAccountStartingBalanceInput } from './LinkAccountStartingBalanceInput';

function renderInput(value: number | null, onChange = vi.fn()) {
  render(
    <TestProviders>
      <LinkAccountStartingBalanceInput
        value={value}
        zeroSign="+"
        onChange={onChange}
      />
    </TestProviders>,
  );
  return onChange;
}

describe('LinkAccountStartingBalanceInput', () => {
  test('reads "Automatic" while no balance has been entered', () => {
    renderInput(null);

    expect(screen.getByRole('button', { name: 'Automatic' })).toBeVisible();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  test('entering a balance reports it', async () => {
    const onChange = renderInput(null);

    await userEvent.click(screen.getByRole('button', { name: 'Automatic' }));
    const input = screen.getByRole('textbox');
    await userEvent.clear(input);
    await userEvent.type(input, '35.07');
    await userEvent.tab();

    expect(onChange).toHaveBeenCalledWith(3507);
  });

  test('leaving the field without typing keeps the balance automatic', async () => {
    const onChange = renderInput(null);

    await userEvent.click(screen.getByRole('button', { name: 'Automatic' }));
    expect(screen.getByRole('textbox')).toHaveFocus();
    await userEvent.tab();

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Automatic' })).toBeVisible();
  });

  test('shows an entered balance and lets it be changed', async () => {
    const onChange = renderInput(3507);

    const input = screen.getByRole('textbox');
    expect(input).toHaveValue('35.07');

    await userEvent.clear(input);
    await userEvent.type(input, '1840.92');
    await userEvent.tab();

    expect(onChange).toHaveBeenCalledWith(184092);
  });

  test('clearing an entered balance switches back to automatic', async () => {
    const onChange = renderInput(3507);

    await userEvent.clear(screen.getByRole('textbox'));
    await userEvent.tab();

    expect(onChange).toHaveBeenCalledWith(null);
  });
});
